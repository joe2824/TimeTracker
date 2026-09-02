// Aenderungen erkennen und mit Herkunftsspuren versehen.
import type { Entry, SyncMeta } from "../types";

/** Ein Datensatz, der eine Identitaet und Aenderungsspuren hat. */
export interface Identified extends SyncMeta {
	id: string;
}

/** Was sich an einem Bestand geaendert hat. */
export interface Changes<T extends Identified> {
	/** Neu hinzugekommen oder inhaltlich veraendert – mit frischem Stempel. */
	changed: T[];
	/**
	 * Was es vorher gab und jetzt nicht mehr - die Datensaetze selbst, nicht nur
	 * ihre Ids.
	 */
	deleted: T[];
}

/** Die Felder, die NICHT zum Inhalt gehoeren. */
const META_KEYS: readonly (keyof SyncMeta)[] = ["updatedAt", "rev", "deviceId"];

/** Ein Datensatz ohne seine Aenderungsspuren. */
export function contentOf<T extends Identified>(item: T): Record<string, unknown> {
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

/** Ob sich der Inhalt zweier Staende desselben Datensatzes unterscheidet. */
function sameContent<T extends Identified>(a: T, b: T): boolean {
	return stable(contentOf(a)) === stable(contentOf(b));
}

function stable(obj: Record<string, unknown>): string {
	return JSON.stringify(obj, Object.keys(obj).sort());
}

/**
 * Zwei Staende vergleichen und die geaenderten Datensaetze stempeln.
 *
 * `after` wird nicht veraendert; die gestempelten Datensaetze kommen als Kopie zurueck.
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

	return { changes: { changed, deleted: [...byId.values()] }, stamped };
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
