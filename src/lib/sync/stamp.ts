// Änderungen erkennen und mit Herkunftsspuren versehen.
import type { SyncMeta } from "../types";
import { stableStringify } from "../utils";

/** Ein Datensatz, der eine Identität und Änderungsspuren hat. */
export interface Identified extends SyncMeta {
	id: string;
}

/** Was sich an einem Bestand geändert hat. */
export interface Changes<T extends Identified> {
	/** Neu hinzugekommen oder inhaltlich verändert – mit frischem Stempel. */
	changed: T[];
	/**
	 * Was es vorher gab und jetzt nicht mehr - die Datensätze selbst, nicht nur
	 * ihre Ids.
	 */
	deleted: T[];
}

/** Die Felder, die NICHT zum Inhalt gehören. */
export const META_KEYS: readonly (keyof SyncMeta)[] = ["updatedAt", "rev", "deviceId"];

/** Die Stempelfelder abstreifen - und sonst nichts anfassen. */
export function withoutStamp<T extends SyncMeta>(item: T): T {
	const rest = { ...item } as Record<string, unknown>;
	for (const k of META_KEYS) delete rest[k];
	return rest as unknown as T;
}

/** Ob an einem Datensatz überhaupt ein Stempel hängt. */
export function isStamped(item: SyncMeta): boolean {
	return META_KEYS.some((k) => item[k] !== undefined);
}

/** Ein Datensatz ohne seine Änderungsspuren. */
export function contentOf<T extends Identified>(item: T): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(item)) {
		if ((META_KEYS as readonly string[]).includes(k)) continue;
		// Ein fehlendes und ein undefined-Feld sind derselbe Inhalt. Ohne das
		// zählte `{note: undefined}` gegen `{}` als Änderung.
		if (v === undefined) continue;
		out[k] = v;
	}
	return out;
}

/** Ob sich der Inhalt zweier Stände desselben Datensatzes unterscheidet. */
function sameContent<T extends Identified>(a: T, b: T): boolean {
	return stableStringify(contentOf(a)) === stableStringify(contentOf(b));
}

/**
 * Zwei Stände vergleichen und die geänderten Datensätze stempeln.
 *
 * `after` wird nicht verändert; die gestempelten Datensätze kommen als Kopie zurück.
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
		// Unverändert UND bereits gestempelt: unangetastet durchreichen.
		if (old && sameContent(old, item) && item.updatedAt !== undefined) {
			stamped.push(item);
			continue;
		}
		// Sonst: neu, inhaltlich verändert, oder noch nie gestempelt (Bestand aus
		// einer Fassung ohne Serveranbindung). Alle drei müssen hochgeladen werden.
		const next = { ...item, updatedAt: now, deviceId } as T;
		// Den Serverstand des Vorgängers weiterreichen, damit der Abgleich weiss,
		// worauf die Änderung aufsetzt.
		if (old?.rev !== undefined && next.rev === undefined) next.rev = old.rev;
		stamped.push(next);
		changed.push(next);
	}

	return { changes: { changed, deleted: [...byId.values()] }, stamped };
}
