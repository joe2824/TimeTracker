// Zusammenfuehren, was von zwei Seiten kommt.
//
// Der Server kann das nicht: er sieht nur Chiffrate. Also entscheidet der
// Client - und weil beide Geraete denselben Code ausfuehren, muessen sie bei
// derselben Ausgangslage zur SELBEN Entscheidung kommen. Sonst laufen sie
// auseinander und schaukeln sich gegenseitig hoch.
//
// Deshalb ist hier alles rein und ohne Zufall: gleiche Eingabe, gleiche
// Ausgabe, auf jedem Geraet.
import type { Entry } from "../types";
import type { SyncMeta } from "../types";

export interface MergeInput<T extends { id: string } & SyncMeta> {
	local: T | undefined;
	remote: T | undefined;
	/** Ob der lokale Stand noch nicht hochgeladen ist. */
	localPending: boolean;
}

export type MergeChoice = "local" | "remote" | "equal";

/**
 * Wer gewinnt.
 *
 * Der juengere Stempel. Bei Gleichstand entscheidet die Geraetekennung - nicht
 * weil ein Geraet wichtiger waere, sondern weil die Entscheidung auf BEIDEN
 * Geraeten gleich ausfallen muss. Zwei Geraete, die bei Gleichstand jeweils
 * "meins" waehlen, ueberschreiben sich gegenseitig bis in alle Ewigkeit.
 */
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
	/**
	 * Ob dabei eine noch nicht hochgeladene lokale Aenderung unterlegen ist.
	 *
	 * Das ist der einzige Fall, den ein Mensch erfahren muss: seine Aenderung ist
	 * weg, und zwar nicht durch sein eigenes Zutun.
	 */
	lostLocalEdit: boolean;
}

/**
 * Einen Datensatz zusammenfuehren.
 *
 * Grabsteine nehmen am selben Wettstreit teil wie alles andere: eine Loeschung
 * ist eine Aenderung wie jede andere und gewinnt, wenn sie juenger ist. Die
 * Alternative - "Loeschung gewinnt immer" - klingt sicherer, macht aber das
 * Wiederanlegen eines versehentlich geloeschten Eintrags unmoeglich, solange
 * irgendein Geraet den Grabstein noch nicht gesehen hat.
 */
export function mergeRecord<T extends { id: string } & SyncMeta>(
	input: MergeInput<T>,
	isTombstone: (v: T) => boolean
): MergeResult<T> {
	const { local, remote, localPending } = input;

	if (!remote) return { value: local ?? null, changed: false, lostLocalEdit: false };

	if (!local) {
		// Kennen wir nicht. Ein Grabstein fuer etwas, das wir ohnehin nicht haben,
		// ist ein Nichts - er darf keine leere Zeile anlegen.
		if (isTombstone(remote)) return { value: null, changed: false, lostLocalEdit: false };
		return { value: remote, changed: true, lostLocalEdit: false };
	}

	// Nichts Eigenes offen: der Serverstand ist die Wahrheit, ohne Wettstreit.
	if (!localPending) {
		const gleich = (local.updatedAt ?? 0) === (remote.updatedAt ?? 0);
		if (gleich) return adoptRev(local, remote);
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

/**
 * Denselben Inhalt behalten, aber die Fassung des Servers uebernehmen.
 *
 * Klingt nach Buchhaltung, ist aber der Unterschied zwischen "gleicht sich ab"
 * und "versucht es ewig": jede Aenderung wird nur angenommen, wenn sie auf der
 * Fassung aufsetzt, die der Server hat. Kommt die nie lokal an, wird jede
 * Folgeaenderung abgewiesen - und eine Loeschung, deren Datensatz schon weg ist,
 * kaeme nie mehr durch.
 */
function adoptRev<T extends SyncMeta>(local: T, remote: T): MergeResult<T> {
	const neu = (remote.rev ?? 0) > (local.rev ?? 0);
	return {
		value: neu ? { ...local, rev: remote.rev } : local,
		changed: neu,
		lostLocalEdit: false
	};
}

/**
 * Nach dem Zusammenfuehren: hoechstens EIN Eintrag darf offen stehen.
 *
 * Das ist die eine Regel, die der Abgleich neu einfuehrt. Bisher konnte ein
 * zweites Fenster einen eigenen offenen Eintrag halten; mit zwei Geraeten waere
 * das der Normalfall - jemand startet am Handy, der Rechner wacht auf und weiss
 * nichts davon.
 *
 * Entschieden wird nach `updatedAt`, nicht nach `startTs`: gemeint ist die
 * juengste HANDLUNG, nicht der frueheste Zeitpunkt. Wer am Handy um 9 startet
 * und um 10 am Rechner etwas anderes startet, meint das zweite - auch wenn
 * dessen Startzeit zurueckdatiert wurde.
 *
 * Die Verlierer werden nicht geloescht, sondern beendet: dort steckt echte
 * Arbeitszeit. Sie enden, wo der Gewinner beginnt - oder, wenn das vor ihrem
 * eigenen Start laege, an ihrem Start (Dauer null statt negativ).
 *
 * @returns die zu aendernden Eintraege; eine leere Liste heisst "alles in Ordnung"
 */
export function resolveOpenEntries(entries: Entry[]): Entry[] {
	const offen = entries.filter((e) => e.endTs === null);
	if (offen.length <= 1) return [];

	const gewinner = offen.reduce((a, b) => (pickWinner(a, b) === "local" ? a : b));
	const out: Entry[] = [];
	for (const e of offen) {
		if (e.id === gewinner.id) continue;
		out.push({ ...e, endTs: Math.max(e.startTs, gewinner.startTs) });
	}
	return out;
}
