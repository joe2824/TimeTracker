// Zusammenfuehren, was von zwei Seiten kommt.
import type { Entry } from "../types";
import type { SyncMeta } from "../types";

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
	/** Was danach lokal gelten soll. Null = loeschen. */
	value: T | null;
	/** Ob der lokale Bestand angefasst werden muss. */
	changed: boolean;
	/** Ob dabei eine noch nicht hochgeladene lokale Aenderung unterlegen ist. */
	lostLocalEdit: boolean;
}

/** Einen Datensatz zusammenfuehren. */
export function mergeRecord<T extends { id: string } & SyncMeta>(
	input: MergeInput<T>,
	isTombstone: (v: T) => boolean
): MergeResult<T> {
	const { local, remote, localPending } = input;

	if (!remote) return { value: local ?? null, changed: false, lostLocalEdit: false };

	if (!local) {
		// Kennen wir nicht. Ein Loeschmarker fuer etwas, das wir ohnehin nicht haben,
		// ist ein Nichts - er darf keine leere Zeile anlegen.
		if (isTombstone(remote)) return { value: null, changed: false, lostLocalEdit: false };
		return { value: remote, changed: true, lostLocalEdit: false };
	}

	// Nichts Eigenes offen: der Serverstand ist die Wahrheit, ohne Wettstreit.
	if (!localPending) {
		// Gleiche Zeit heisst sonst: derselbe Stand, es bleibt nur die Fassung
		// mitzunehmen.
		//
		// Fuer einen Loeschmarker gilt das NICHT. Anlegen und Loeschen koennen in
		// dieselbe Millisekunde fallen - deleteYear stempelt alle Eintraege eines
		// Jahres mit demselben Date.now(), und auf einem schnellen Rechner trifft
		// das den Eintrag, der gerade erst entstanden ist. Die Abkuerzung
		// verschluckte die Loeschung dann: das andere Geraet behielt den Eintrag,
		// erfuhr nie davon und schob ihn beim naechsten Abgleich wieder hoch.
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
		// uebernommen. Genau daran haengt die Aufloesung eines Konflikts: der
		// naechste Versuch setzt dann auf dem Stand auf, den der Server hat, und
		// kommt durch. Ohne das schickte dasselbe Geraet endlos dieselbe
		// abgelehnte Aenderung.
		return adoptRev(local, remote);
	}
	return {
		value: isTombstone(remote) ? null : remote,
		changed: true,
		// Genau hier verliert jemand etwas, das er selbst geaendert hat.
		lostLocalEdit: true
	};
}

/** Denselben Inhalt behalten, aber die Fassung des Servers uebernehmen. */
function adoptRev<T extends SyncMeta>(local: T, remote: T): MergeResult<T> {
	const fresh = (remote.rev ?? 0) > (local.rev ?? 0);
	return {
		value: fresh ? { ...local, rev: remote.rev } : local,
		changed: fresh,
		lostLocalEdit: false
	};
}

/**
 * Nach dem Zusammenfuehren: hoechstens EIN Eintrag darf offen stehen.
 *
 * @returns die zu aendernden Eintraege; eine leere Liste heisst "alles in Ordnung"
 */
export function resolveOpenEntries(entries: Entry[]): Entry[] {
	const open = entries.filter((e) => e.endTs === null);
	if (open.length <= 1) return [];

	const winner = open.reduce((a, b) => (pickWinner(a, b) === "local" ? a : b));
	const out: Entry[] = [];
	for (const e of open) {
		if (e.id === winner.id) continue;
		out.push({ ...e, endTs: Math.max(e.startTs, winner.startTs) });
	}
	return out;
}
