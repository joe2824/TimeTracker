// Was noch nicht beim Server ist. Gemerkt wird NUR, WAS sich geaendert hat - Art, Id,
// bei Eintraegen der Monat - nie der Inhalt selbst.
import type { Activity, Entry, Settings, SyncMeta } from "../types";
import type { WriteHook } from "../store";
import {
	listEntryMonths,
	loadActivities,
	loadEntries,
	loadOutbox,
	loadSettings,
	saveOutbox,
	setWriteHook,
	settingsFileExists
} from "../store";
import { diffAndStamp } from "./stamp";
import { logWarn } from "../log";

export type RecordKind = "entry" | "activity" | "settings";

/** Die Id des einen Einstellungs-Datensatzes – es gibt genau einen. */
export const SETTINGS_ID = "settings";

export interface PendingChange {
	kind: RecordKind;
	id: string;
	/** Nur bei Eintraegen: in welcher Monatsdatei der Datensatz liegt bzw. lag. */
	month?: string;
	deleted: boolean;
	/** Bei einer Loeschung: die Fassung, die der Datensatz zuletzt hatte. */
	rev?: number;
	/** Wann die Aenderung bemerkt wurde (Epoch-ms). */
	at: number;
}

/** Schluessel, unter dem eine Aenderung eindeutig ist. */
function keyOf(c: Pick<PendingChange, "kind" | "id">): string {
	return `${c.kind}:${c.id}`;
}

/** Mehrere Aenderungen am selben Datensatz zu einer zusammenfassen. */
export function mergePending(existing: PendingChange[], incoming: PendingChange[]): PendingChange[] {
	const byKey = new Map(existing.map((c) => [keyOf(c), c]));
	for (const c of incoming) byKey.set(keyOf(c), c);
	return [...byKey.values()];
}

let pending: PendingChange[] = [];
let loaded = false;
let deviceId = "";

/** Waehrend der Abgleich Fremdes einspielt, wird nichts vorgemerkt. */
let suppressed = 0;

/** Etwas schreiben, ohne es vorzumerken. */
export async function applyingRemote<T>(fn: () => Promise<T>): Promise<T> {
	suppressed++;
	try {
		return await fn();
	} finally {
		suppressed--;
	}
}

/** Ausstehende Aenderungen, aelteste zuerst. */
export function pendingChanges(): PendingChange[] {
	return [...pending].sort((a, b) => a.at - b.at);
}

/** Aenderungen als erledigt abhaken - ueber Schluessel, damit inzwischen Dazugekommenes bleibt. */
export async function clearChanges(done: Pick<PendingChange, "kind" | "id">[]): Promise<void> {
	const keys = new Set(done.map(keyOf));
	pending = pending.filter((c) => !keys.has(keyOf(c)));
	await persist();
}

async function persist(): Promise<void> {
	try {
		await saveOutbox(pending);
	} catch (e) {
		// Der Verlust ist verkraftbar: beim naechsten Start wird der gesamte
		// Bestand gegen den Server abgeglichen. Speichern darf daran nie scheitern.
		logWarn("Outbox konnte nicht gespeichert werden", e);
	}
}

/** Wer erfahren will, dass etwas zu tun ist. */
let onChange: (() => void) | null = null;

export function setChangeListener(fn: (() => void) | null): void {
	onChange = fn;
}

async function note(changes: PendingChange[]): Promise<void> {
	if (changes.length === 0) return;
	pending = mergePending(pending, changes);
	await persist();
	onChange?.();
}

/** Den Abgleich scharf schalten. */
export async function startTracking(device: string): Promise<void> {
	deviceId = device;
	if (!loaded) {
		try {
			pending = await loadOutbox();
		} catch (e) {
			logWarn("Outbox nicht lesbar, beginne leer", e);
			pending = [];
		}
		loaded = true;
	}
	setWriteHook(hook);
}

/**
 * Alles vormerken, was der Server noch nicht hat.
 *
 * Erkennbar am fehlenden Stempel: was einmal abgeglichen war, traegt `rev`.
 * Fuer den ersten Abgleich nach dem Verknuepfen - davor lief kein Schreib-Haken,
 * der vorhandene Bestand ginge sonst nie hoch.
 * Mit `forceAll = true` wird der gesamte lokale Bestand vorgemerkt (z.B. nach Server-Reset oder Neuverknüpfung).
 */
export async function merkeUngestempeltes(forceAll = false): Promise<void> {
	const now = Date.now();
	const changes: PendingChange[] = [];

	for (const month of await listEntryMonths()) {
		for (const e of await loadEntries(month)) {
			if (forceAll || e.rev === undefined) changes.push({ kind: "entry", id: e.id, month, deleted: false, at: now });
		}
	}
	for (const a of await loadActivities()) {
		if (forceAll || a.rev === undefined) changes.push({ kind: "activity", id: a.id, deleted: false, at: now });
	}
	// Nur wenn dieses Geraet ueberhaupt schon Einstellungen hat - sonst entstuende
	// aus blossen Voreinstellungen ein Datensatz.
	if (await settingsFileExists()) {
		const s = (await loadSettings()) as Settings & SyncMeta;
		if (forceAll || s.rev === undefined) changes.push({ kind: "settings", id: SETTINGS_ID, deleted: false, at: now });
	}

	await note(changes);
}

/** Den Abgleich abschalten – das Programm verhaelt sich danach wieder rein lokal. */
export function stopTracking(): void {
	setWriteHook(null);
}

const hook: WriteHook = {
	async entries(month, before, after) {
		if (suppressed > 0) return after;
		const now = Date.now();
		const { changes, stamped } = diffAndStamp(before, after, deviceId, now);
		await note([
			...changes.changed.map((e: Entry) => ({ kind: "entry" as const, id: e.id, month, deleted: false, at: now })),
			...changes.deleted.map((e: Entry) => ({
				kind: "entry" as const,
				id: e.id,
				month,
				deleted: true,
				rev: e.rev,
				at: now
			}))
		]);
		return stamped;
	},

	async activities(before, after) {
		if (suppressed > 0) return after;
		const now = Date.now();
		const { changes, stamped } = diffAndStamp(before, after, deviceId, now);
		await note([
			...changes.changed.map((a: Activity) => ({ kind: "activity" as const, id: a.id, deleted: false, at: now })),
			...changes.deleted.map((a: Activity) => ({
				kind: "activity" as const,
				id: a.id,
				deleted: true,
				rev: a.rev,
				at: now
			}))
		]);
		return stamped;
	},

	async settings(before, after) {
		if (suppressed > 0) return after;
		const now = Date.now();
		// Die Einstellungen sind EIN Datensatz, kein Bestand – deshalb ueber eine
		// einelementige Liste mit fester Id statt ueber echte Identitaeten.
		const wrap = (s: Settings | null) => (s ? [{ ...s, id: SETTINGS_ID }] : []);
		const { changes, stamped } = diffAndStamp(wrap(before), wrap(after), deviceId, now);
		await note(changes.changed.map(() => ({ kind: "settings" as const, id: SETTINGS_ID, deleted: false, at: now })));
		// Die geliehene Id gehoert nicht in die Datei zurueck.
		const { id: _id, ...rest } = stamped[0];
		return rest as Settings;
	}
};

/** Nur fuer Tests: den Modulzustand vergessen. */
export function resetOutboxForTests(): void {
	onChange = null;
	pending = [];
	loaded = false;
	deviceId = "";
	suppressed = 0;
	setWriteHook(null);
}
