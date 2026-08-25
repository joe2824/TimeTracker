// Aenderungen erkennen und mit Herkunftsspuren versehen.
//
// Reine Rechnung, ohne Dateizugriff: hier steht NUR, was sich zwischen zwei
// Staenden geaendert hat und welche Spuren die geaenderten Datensaetze bekommen.
// Wer das aufruft und wohin das Ergebnis geht, steht in store.ts und outbox.ts.
//
// Der Vergleich sitzt bewusst an der Speicher-Grenze und nicht an den einzelnen
// Mutationen: die Eintraege werden von der Tracking-Seite, dem Eintrags-Editor,
// dem Sammel-Dialog, dem Urlaubszeitraum, dem Kalender-Import und dem
// LOGA-Nachtrag veraendert. Jede dieser Stellen einzeln zu stempeln hiesse, es
// frueher oder spaeter an einer davon zu vergessen – und ein vergessener Stempel
// ist ein Datensatz, der stillschweigend nicht synchronisiert wird.
import type { Entry, SyncMeta } from "../types";

/** Ein Datensatz, der eine Identitaet und Aenderungsspuren hat. */
export interface Identified extends SyncMeta {
	id: string;
}

/** Was sich an einem Bestand geaendert hat. */
export interface Changes<T extends Identified> {
	/** Neu hinzugekommen oder inhaltlich veraendert – mit frischem Stempel. */
	changed: T[];
	/** Ids, die es vorher gab und jetzt nicht mehr. */
	deleted: string[];
}

/**
 * Die Felder, die NICHT zum Inhalt gehoeren.
 *
 * Sie muessen beim Vergleich draussen bleiben, sonst gilt jeder Datensatz als
 * veraendert, sobald er einmal gestempelt wurde: der Stempel selbst waere die
 * Aenderung, und das naechste Speichern stempelte erneut. Eine Endlosschleife
 * aus lauter Selbstbestaetigung.
 */
const META_KEYS: readonly (keyof SyncMeta)[] = ["updatedAt", "rev", "deviceId"];

/** Ein Datensatz ohne seine Aenderungsspuren. */
function contentOf<T extends Identified>(item: T): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(item)) {
		if ((META_KEYS as readonly string[]).includes(k)) continue;
		// Ein fehlendes und ein undefined-Feld sind derselbe Inhalt. Ohne das
		// zaehlte `{note: undefined}` gegen `{}` als Aenderung.
		if (v === undefined) continue;
		out[k] = v;
	}
	return out;
}

/**
 * Ob sich der Inhalt zweier Staende desselben Datensatzes unterscheidet.
 *
 * Vergleicht ueber JSON mit sortierten Schluesseln: die Datensaetze sind flache
 * Objekte aus Zahlen, Zeichenketten und Wahrheitswerten, ein tiefer Vergleich
 * waere hier Aufwand ohne Gewinn. Sortiert, weil die Schluesselreihenfolge
 * davon abhaengt, wie ein Objekt entstanden ist – ein neu gebauter Eintrag hat
 * sie anders als einer aus JSON.parse.
 */
function sameContent<T extends Identified>(a: T, b: T): boolean {
	return stable(contentOf(a)) === stable(contentOf(b));
}

function stable(obj: Record<string, unknown>): string {
	return JSON.stringify(obj, Object.keys(obj).sort());
}

/**
 * Zwei Staende vergleichen und die geaenderten Datensaetze stempeln.
 *
 * `after` wird NICHT veraendert; die gestempelten Datensaetze kommen als Kopie
 * zurueck, zusammen mit der vollstaendigen neuen Liste zum Schreiben.
 *
 * `rev` bleibt unangetastet: die Zahl vergibt der Server. Lokal wird sie nur
 * mitgefuehrt, damit der naechste Abgleich weiss, auf welchem Serverstand die
 * Aenderung aufsetzt.
 */
export function diffAndStamp<T extends Identified>(
	before: T[],
	after: T[],
	deviceId: string,
	now: number
): { changes: Changes<T>; stamped: T[] } {
	const byId = new Map(before.map((x) => [x.id, x]));
	const changed: T[] = [];
	const stamped: T[] = [];

	for (const item of after) {
		const old = byId.get(item.id);
		byId.delete(item.id);
		// Unveraendert UND bereits gestempelt: unangetastet durchreichen.
		if (old && sameContent(old, item) && item.updatedAt !== undefined) {
			stamped.push(item);
			continue;
		}
		// Sonst: neu, inhaltlich veraendert, oder noch nie gestempelt (Bestand aus
		// einer Fassung ohne Serveranbindung). Alle drei muessen hochgeladen werden.
		const next = { ...item, updatedAt: now, deviceId } as T;
		// Den Serverstand des Vorgaengers weiterreichen, damit der Abgleich weiss,
		// worauf die Aenderung aufsetzt.
		if (old?.rev !== undefined && next.rev === undefined) next.rev = old.rev;
		stamped.push(next);
		changed.push(next);
	}

	return { changes: { changed, deleted: [...byId.keys()] }, stamped };
}

/** Eintraege eines Monats vergleichen – dieselbe Rechnung, engerer Typ. */
export function diffEntries(
	before: Entry[],
	after: Entry[],
	deviceId: string,
	now: number
): { changes: Changes<Entry>; stamped: Entry[] } {
	return diffAndStamp(before, after, deviceId, now);
}
