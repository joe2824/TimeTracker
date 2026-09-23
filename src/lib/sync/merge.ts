// Zusammenführen, was von zwei Seiten kommt.
import type { Entry } from "../types";
import type { SyncMeta } from "../types";
import { startOfNextDay } from "../time/time";

export interface MergeInput<T extends { id: string } & SyncMeta> {
	local: T | undefined;
	remote: T | undefined;
	/** Ob der lokale Stand noch nicht hochgeladen ist. */
	localPending: boolean;
}

export type MergeChoice = "local" | "remote" | "equal";

/** Wer gewinnt. */
export function pickWinner<T extends SyncMeta>(local: T, remote: T): MergeChoice {
	const l = local.updatedAt ?? 0;
	const r = remote.updatedAt ?? 0;
	if (l > r) return "local";
	if (r > l) return "remote";
	const ld = local.deviceId ?? "";
	const rd = remote.deviceId ?? "";
	if (ld === rd) return "equal";
	return ld > rd ? "local" : "remote";
}

export interface MergeResult<T> {
	/** Was danach lokal gelten soll. Null = löschen. */
	value: T | null;
	/** Ob der lokale Bestand angefasst werden muss. */
	changed: boolean;
	/** Ob dabei eine noch nicht hochgeladene lokale Änderung unterlegen ist. */
	lostLocalEdit: boolean;
}

/** Einen Datensatz zusammenführen. */
export function mergeRecord<T extends { id: string } & SyncMeta>(
	input: MergeInput<T>,
	isTombstone: (v: T) => boolean
): MergeResult<T> {
	const { local, remote, localPending } = input;

	if (!remote) return { value: local ?? null, changed: false, lostLocalEdit: false };

	if (!local) {
		// Kennen wir nicht. Ein Löschmarker für etwas, das wir ohnehin nicht haben,
		// ist ein Nichts - er darf keine leere Zeile anlegen.
		if (isTombstone(remote)) return { value: null, changed: false, lostLocalEdit: false };
		return { value: remote, changed: true, lostLocalEdit: false };
	}

	// Nichts Eigenes offen: der Serverstand ist die Wahrheit, ohne Wettstreit.
	if (!localPending) {
		// Gleiche Zeit heisst sonst: derselbe Stand, es bleibt nur die Fassung
		// mitzunehmen.
		//
		// Für einen Löschmarker gilt das NICHT. Anlegen und Löschen können in
		// dieselbe Millisekunde fallen - deleteYear stempelt alle Einträge eines
		// Jahres mit demselben Date.now(), und auf einem schnellen Rechner trifft
		// das den Eintrag, der gerade erst entstanden ist. Die Abkürzung
		// verschluckte die Löschung dann: das andere Gerät behielt den Eintrag,
		// erfuhr nie davon und schob ihn beim nächsten Abgleich wieder hoch.
		const equal = (local.updatedAt ?? 0) === (remote.updatedAt ?? 0);
		if (equal && !isTombstone(remote)) return adoptRev(local, remote);
		return {
			value: isTombstone(remote) ? null : remote,
			changed: true,
			lostLocalEdit: false
		};
	}

	const winner = pickWinner(local, remote);
	if (winner === "local" || winner === "equal") {
		// Der Inhalt bleibt der eigene - die FASSUNG des Servers wird trotzdem
		// übernommen. Genau daran hängt die Auflösung eines Konflikts: der
		// nächste Versuch setzt dann auf dem Stand auf, den der Server hat, und
		// kommt durch. Ohne das schickte dasselbe Gerät endlos dieselbe
		// abgelehnte Änderung.
		return adoptRev(local, remote);
	}
	return {
		value: isTombstone(remote) ? null : remote,
		changed: true,
		// Genau hier verliert jemand etwas, das er selbst geändert hat.
		lostLocalEdit: true
	};
}

/** Denselben Inhalt behalten, aber die Fassung des Servers übernehmen. */
function adoptRev<T extends SyncMeta>(local: T, remote: T): MergeResult<T> {
	const fresh = (remote.rev ?? 0) > (local.rev ?? 0);
	return {
		value: fresh ? { ...local, rev: remote.rev } : local,
		changed: fresh,
		lostLocalEdit: false
	};
}

/**
 * Nach dem Zusammenführen: höchstens EIN Eintrag darf offen stehen.
 *
 * @returns die zu ändernden Einträge; eine leere Liste heisst "alles in Ordnung"
 */
export function resolveOpenEntries(entries: Entry[]): Entry[] {
	const open = entries.filter((e) => e.endTs === null);
	if (open.length <= 1) return [];

	// Ein wirklich gestarteter Lauf schlägt eine geratene Fortsetzung. Nach
	// `pickWinner` gewänne die Fortsetzung immer: ihr Stempel entsteht beim Start
	// der App, ist damit der jüngste - und schlösse den Timer, den jemand gerade
	// auf einem anderen Gerät hält.
	const guessed = new Set(open.filter((e) => isGuessedContinuation(e, entries)).map((e) => e.id));
	const real = open.filter((e) => !guessed.has(e.id));
	const field = real.length > 0 ? real : open;
	const winner = field.reduce((a, b) => (pickWinner(a, b) === "local" ? a : b));

	const out: Entry[] = [];
	for (const e of open) {
		if (e.id === winner.id) continue;
		// Eine Fortsetzung endet an ihrem eigenen Start. Bis zum Start des Siegers
		// zu verlängern hiesse, Stunden zu erfinden, die niemand gestempelt hat -
		// was nach Mitternacht wirklich lief, kann nur ein Mensch sagen, und der
		// Abgleich meldet ihm den Fall.
		const end = guessed.has(e.id) ? e.startTs : Math.max(e.startTs, winner.startTs);
		out.push({ ...e, endTs: end });
	}
	return out;
}

/**
 * Eine Mitternachts-Fortsetzung, deren Grundlage weggefallen ist.
 *
 * Findet die App einen Lauf über die Tagesgrenze hinweg offen, teilt sie ihn -
 * notfalls aus einem veralteten Stand, etwa beim Start nach einer Nacht ohne
 * Verbindung. Endet der geteilte Lauf in Wahrheit früher, weil ihn ein anderes
 * Gerät beendet hat, schliesst die Fortsetzung an nichts mehr an: ihr Stempel
 * ist jung, ihr Inhalt geraten.
 *
 * Eine Fortsetzung ohne diese Lücke ist dagegen bestätigt und zählt normal.
 */
function isGuessedContinuation(entry: Entry, all: Entry[]): boolean {
	return all.some(
		(e) =>
			e.id !== entry.id &&
			e.activityId === entry.activityId &&
			e.endTs !== null &&
			e.endTs < entry.startTs &&
			entry.startTs === startOfNextDay(e.startTs)
	);
}
