// Was noch nicht beim Server ist. Gemerkt wird NUR, WAS sich geändert hat - Art, Id,
// bei Einträgen der Monat - nie der Inhalt selbst.
import type { Activity, Entry, Settings, SyncMeta } from "../types";
import type { StoredTimeReport, WriteHook } from "../store";
import {
	listEntryMonths,
	listTimeReportMonths,
	loadActivities,
	loadEntries,
	loadOutbox,
	loadSettings,
	loadTimeReport,
	saveOutbox,
	setWriteHook,
	settingsFileExists
} from "../store";
import { diffAndStamp } from "./stamp";
import { logWarn } from "../log";

export type RecordKind = "entry" | "activity" | "settings" | "timereport";

/** Die Id des einen Einstellungs-Datensatzes – es gibt genau einen. */
export const SETTINGS_ID = "settings";

/**
 * Die Id eines Reports: der Monat mit Vorsatz.
 *
 * Der Server führt seine Datensätze allein über die Id, ohne die Art daneben.
 * Ein blosses "2026-07" könnte deshalb mit einer anderen Art zusammenstossen.
 */
export function timeReportId(month: string): string {
	return `timereport:${month}`;
}

/** Der Monat zu einer Report-Id; leer, wenn die Id keine ist. */
export function monthOfTimeReportId(id: string): string {
	return id.startsWith("timereport:") ? id.slice("timereport:".length) : "";
}

export interface PendingChange {
	kind: RecordKind;
	id: string;
	/** Nur bei Einträgen: in welcher Monatsdatei der Datensatz liegt bzw. lag. */
	month?: string;
	deleted: boolean;
	/** Bei einer Löschung: die Fassung, die der Datensatz zuletzt hatte. */
	rev?: number;
	/** Wann die Änderung bemerkt wurde (Epoch-ms). */
	at: number;
}

/** Schlüssel, unter dem eine Änderung eindeutig ist. */
function keyOf(c: Pick<PendingChange, "kind" | "id">): string {
	return `${c.kind}:${c.id}`;
}

/** Mehrere Änderungen am selben Datensatz zu einer zusammenfassen. */
export function mergePending(existing: PendingChange[], incoming: PendingChange[]): PendingChange[] {
	const byKey = new Map(existing.map((c) => [keyOf(c), c]));
	for (const c of incoming) byKey.set(keyOf(c), c);
	return [...byKey.values()];
}

let pending: PendingChange[] = [];
let loaded = false;
let deviceId = "";

/** Während der Abgleich Fremdes einspielt, wird nichts vorgemerkt. */
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

/** Ausstehende Änderungen, älteste zuerst. */
export function pendingChanges(): PendingChange[] {
	return [...pending].sort((a, b) => a.at - b.at);
}

/** Änderungen als erledigt abhaken - über Schlüssel, damit inzwischen Dazugekommenes bleibt. */
export async function clearChanges(done: Pick<PendingChange, "kind" | "id">[]): Promise<void> {
	const keys = new Set(done.map(keyOf));
	pending = pending.filter((c) => !keys.has(keyOf(c)));
	await persist();
}

/**
 * Etwas vormerken, das nicht über den Schreib-Haken kam.
 *
 * Für Entscheidungen, die der Abgleich selbst trifft, während er Fremdes
 * einspielt: dort ist der Haken abgeschaltet (`applyingRemote`), und ohne diesen
 * Weg bliebe die Entscheidung auf diesem Gerät liegen.
 */
export async function noteChanges(changes: PendingChange[]): Promise<void> {
	await note(changes);
}

/**
 * Eine offene Löschung auf die Fassung setzen, die der Server kennt.
 *
 * Ein Datensatz, der lokal noch liegt, nimmt die Fassung des Servers beim
 * Zusammenführen mit (`adoptRev` in merge.ts) - eine Löschung hat dafür nichts
 * mehr. Ohne das hier schickt dieses Gerät dieselbe abgelehnte Löschung endlos
 * weiter.
 */
export async function rebaseChanges(
	updates: (Pick<PendingChange, "kind" | "id"> & { rev: number })[]
): Promise<void> {
	if (updates.length === 0) return;
	const revs = new Map(updates.map((u) => [keyOf(u), u.rev]));
	let touched = false;
	pending = pending.map((c) => {
		const rev = revs.get(keyOf(c));
		if (rev === undefined || c.rev === rev) return c;
		touched = true;
		return { ...c, rev };
	});
	if (touched) await persist();
}

async function persist(): Promise<void> {
	try {
		await saveOutbox(pending);
	} catch (e) {
		// Der Verlust ist verkraftbar: beim nächsten Start wird der gesamte
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
 * Erkennbar am fehlenden Stempel: was einmal abgeglichen war, trägt `rev`.
 * Für den ersten Abgleich nach dem Verknüpfen - davor lief kein Schreib-Haken,
 * der vorhandene Bestand ginge sonst nie hoch.
 * Mit `forceAll = true` wird der gesamte lokale Bestand vorgemerkt (z.B. nach Server-Reset oder Neuverknüpfung).
 */
export async function rememberUnstamped(forceAll = false): Promise<void> {
	const now = Date.now();
	const changes: PendingChange[] = [];

	for (const month of await listEntryMonths()) {
		for (const e of await loadEntries(month)) {
			if (forceAll || e.rev === undefined) changes.push({ kind: "entry", id: e.id, month, deleted: false, at: now });
		}
	}
	for (const a of await loadActivities()) {
		// Team-Zeilen tragen nie ein rev (siehe hook.activities) - ohne den
		// Ausschluss versuchte jeder Nachlauf erneut, sie als eigene hochzuladen.
		if (a.teamOwned) continue;
		if (forceAll || a.rev === undefined) changes.push({ kind: "activity", id: a.id, deleted: false, at: now });
	}
	// Nur wenn dieses Gerät überhaupt schon Einstellungen hat - sonst entstünde
	// aus blossen Voreinstellungen ein Datensatz.
	if (await settingsFileExists()) {
		const s = (await loadSettings()) as Settings & SyncMeta;
		if (forceAll || s.rev === undefined) changes.push({ kind: "settings", id: SETTINGS_ID, deleted: false, at: now });
	}
	for (const month of await listTimeReportMonths()) {
		const report = await loadTimeReport(month);
		if (!report) continue;
		if (forceAll || report.rev === undefined) {
			changes.push({ kind: "timereport", id: timeReportId(month), deleted: false, at: now });
		}
	}

	await note(changes);
}

/** Den Abgleich abschalten – das Programm verhält sich danach wieder rein lokal. */
export function stopTracking(): void {
	setWriteHook(null);
	pending = [];
	loaded = false;
	deviceId = "";
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
		// Vom Team vorgegebene Zeilen gehören nicht in dieses Konto - sie kommen
		// über den eigenen Team-Kanal (team/activities.ts), nicht über den
		// Ende-zu-Ende-verschlüsselten Sync. Ohne diesen Ausschluss liefen sie
		// als "persönliche Änderung" hoch und landeten auf JEDEM anderen Gerät
		// dieses Kontos - auch auf einem ganz ohne Team-Mitgliedschaft.
		const isTeamOwned = (a: Activity) => a.teamOwned === true;
		const teamRows = after.filter(isTeamOwned);
		const { changes, stamped } = diffAndStamp(
			before.filter((a) => !isTeamOwned(a)),
			after.filter((a) => !isTeamOwned(a)),
			deviceId,
			now
		);
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
		return [...stamped, ...teamRows];
	},

	async settings(before, after) {
		if (suppressed > 0) return after;
		const now = Date.now();
		// Die Einstellungen sind EIN Datensatz, kein Bestand – deshalb über eine
		// einelementige Liste mit fester Id statt über echte Identitäten.
		const wrap = (s: Settings | null) => (s ? [{ ...s, id: SETTINGS_ID }] : []);
		const { changes, stamped } = diffAndStamp(wrap(before), wrap(after), deviceId, now);
		await note(changes.changed.map(() => ({ kind: "settings" as const, id: SETTINGS_ID, deleted: false, at: now })));
		// Die geliehene Id gehört nicht in die Datei zurück.
		const { id: _id, ...rest } = stamped[0];
		return rest as Settings;
	},

	async timeReport(month, before, after) {
		if (suppressed > 0) return after;
		const now = Date.now();
		const id = timeReportId(month);
		// Ein Report je Monat, also derselbe Kniff wie bei den Einstellungen: eine
		// einelementige Liste mit geliehener Id.
		const wrap = (r: StoredTimeReport | null) => (r ? [{ ...r, id }] : []);
		const { changes, stamped } = diffAndStamp(wrap(before), wrap(after), deviceId, now);
		await note([
			...changes.changed.map(() => ({ kind: "timereport" as const, id, deleted: false, at: now })),
			...changes.deleted.map((r) => ({
				kind: "timereport" as const,
				id,
				deleted: true,
				rev: r.rev,
				at: now
			}))
		]);
		if (stamped.length === 0) return null;
		const { id: _id, ...rest } = stamped[0];
		return rest as StoredTimeReport;
	}
};

/** Nur für Tests: den Modulzustand vergessen. */
export function resetOutboxForTests(): void {
	onChange = null;
	pending = [];
	loaded = false;
	deviceId = "";
	suppressed = 0;
	setWriteHook(null);
}
