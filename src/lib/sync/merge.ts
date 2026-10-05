// Zusammenführen, was von zwei Seiten kommt.
import type { Entry } from "../types";
import type { SyncMeta } from "../types";
import { startOfNextDay } from "../time/time";
import { lostLocalField, mergeFields, pickWinner, sameFields, type FieldRules } from "./fieldMerge";

export interface MergeInput<T extends { id: string } & SyncMeta> {
	local: T | undefined;
	remote: T | undefined;
	/** Ob der lokale Stand noch nicht hochgeladen ist. */
	localPending: boolean;
}

export type MergeChoice = "local" | "remote" | "equal";

export { pickWinner };

export interface MergeResult<T> {
	/** Was danach lokal gelten soll. Null = löschen. */
	value: T | null;
	/** Ob der lokale Bestand angefasst werden muss. */
	changed: boolean;
	/** Ob dabei eine noch nicht hochgeladene lokale Änderung unterlegen ist. */
	lostLocalEdit: boolean;
	/** Ob das Ergebnis Felder trägt, die der Server noch nicht hat. */
	needsPush?: boolean;
}

/** Einen Datensatz zusammenführen. */
export function mergeRecord<T extends { id: string } & SyncMeta>(
	input: MergeInput<T>,
	isTombstone: (v: T) => boolean,
	fields?: FieldRules
): MergeResult<T> {
	const { local, remote, localPending } = input;

	if (!remote) return { value: local ?? null, changed: false, lostLocalEdit: false };

	if (!local) {
		// Kennen wir nicht. Ein Löschmarker für etwas, das wir ohnehin nicht haben,
		// ist ein Nichts - er darf keine leere Zeile anlegen.
		if (isTombstone(remote)) return { value: null, changed: false, lostLocalEdit: false };
		return { value: remote, changed: true, lostLocalEdit: false };
	}

	// Feldweise, solange beide Stände leben: Löschen gegen Ändern entscheidet
	// weiter der Datensatz als Ganzes.
	if (fields && !isTombstone(remote)) return mergeAlive(local, remote, localPending, fields);

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

/**
 * Zwei lebende Stände feldweise zusammenführen. Auch ohne eigene offene
 * Änderung: ein jüngeres Feld von hier geht dann eben hinauf, statt still
 * unter einem älteren Serverstand zu verschwinden.
 */
function mergeAlive<T extends { id: string } & SyncMeta>(
	local: T,
	remote: T,
	localPending: boolean,
	fields: FieldRules
): MergeResult<T> {
	const merged = mergeFields(local, remote, fields);
	const needsPush = !sameFields(merged, remote);
	if (sameFields(merged, local)) return { ...adoptRev(local, remote), needsPush };
	return {
		value: merged,
		changed: true,
		lostLocalEdit: localPending && lostLocalField(local, merged, fields),
		needsPush
	};
}

/** Denselben Inhalt behalten, aber die Fassung des Servers übernehmen. */
export function adoptRev<T extends SyncMeta>(local: T, remote: T): MergeResult<T> {
	const fresh = (remote.rev ?? 0) > (local.rev ?? 0);
	return {
		value: fresh ? { ...local, rev: remote.rev } : local,
		changed: fresh,
		lostLocalEdit: false
	};
}

/**
 * Ob das Ende von der Mitternachts-Teilung stammt. Nur zusammen mit einem Ende
 * genau an der Tagesgrenze: hat eine ältere Fassung das Ende verschoben und die
 * Marke mitgeschleppt, zählt das Ende als echt.
 */
export function isAutoEnd(e: Entry): boolean {
	return e.autoEnded === true && e.endTs !== null && e.endTs === startOfNextDay(e.startTs);
}

/**
 * Ein echtes Ende gegen ein automatisches - unabhängig vom Stempel.
 *
 * `remote === null` steht für eine Löschung. `null` als Ergebnis heisst: die
 * Regel greift nicht, es entscheidet der Stempel.
 */
export function realEndWinner(local: Entry, remote: Entry | null): "local" | "remote" | null {
	if (remote === null) return isAutoEnd(local) ? "remote" : null;
	if (remote.endTs === local.endTs) return null;
	const localAuto = isAutoEnd(local);
	const remoteAuto = isAutoEnd(remote);
	if (localAuto && !remoteAuto && remote.endTs !== null) return "remote";
	if (remoteAuto && !localAuto && local.endTs !== null) return "local";
	return null;
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
