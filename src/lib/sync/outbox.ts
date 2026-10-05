// Was noch nicht beim Server ist. Gemerkt wird NUR, WAS sich geändert hat - Art, Id,
// bei Einträgen der Monat - nie der Inhalt selbst.
import type { Activity, Entry, Settings, SyncMeta } from "../types";
import type { WriteHook } from "../store";
import {
	acrossWindows,
	listEntryMonths,
	listTimeReportMonths,
	loadActivities,
	loadEntries,
	loadOutbox,
	loadSettings,
	loadTimeReport,
	remoteStore,
	saveOutbox,
	setWriteHook,
	settingsFileExists
} from "../store";
import { diffAndStamp } from "./stamp";
import { SETTINGS_FIELDS, type StampedSettings } from "./settingsMerge";
import { ACTIVITY_FIELDS, ENTRY_FIELDS, stampFields } from "./fieldMerge";
import { logWarn } from "../log";
import { createSerialQueue } from "../utils";

export type RecordKind = "entry" | "activity" | "settings" | "timereport" | "team";

/** Die Id des einen Einstellungs-Datensatzes – es gibt genau einen. */
export const SETTINGS_ID = "settings";

/** Die Id der Team-Mitgliedschaft – je Konto höchstens eine. */
export const TEAM_RECORD_ID = "team-membership";

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

/** Mehrere Änderungen am selben Datensatz zu einer zusammenfassen – die jüngste gilt. */
export function mergePending(existing: PendingChange[], incoming: PendingChange[]): PendingChange[] {
	const byKey = new Map(existing.map((c) => [keyOf(c), c]));
	for (const c of incoming) {
		const had = byKey.get(keyOf(c));
		if (!had || had.at <= c.at) byKey.set(keyOf(c), c);
	}
	return [...byKey.values()];
}

/**
 * Zwischenstand der Datei. Maßgeblich ist outbox.json: Haupt- und Tray-Fenster
 * haben je eigenen Modulzustand, merken aber in dieselbe Datei vor. Jede
 * Änderung liest sie deshalb frisch, statt eine eigene Liste darüberzuschreiben.
 */
let pending: PendingChange[] = [];
let loaded = false;
let deviceId = "";

/** Ausstehende Änderungen, älteste zuerst – Stand des letzten Lesens. */
export function pendingChanges(): PendingChange[] {
	return [...pending].sort((a, b) => a.at - b.at);
}

/** Frisch lesen, was inzwischen auch andere Fenster vorgemerkt haben. */
export async function refreshPending(): Promise<void> {
	await update(() => null);
}

/**
 * Änderungen als erledigt abhaken – über Schlüssel, damit inzwischen
 * Dazugekommenes bleibt, und nur bis zu ihrem Zeitpunkt: eine jüngere Änderung
 * am selben Datensatz ist womöglich nicht mit hochgegangen.
 */
export async function clearChanges(
	done: (Pick<PendingChange, "kind" | "id"> & { at?: number })[]
): Promise<void> {
	const upTo = new Map(done.map((d) => [keyOf(d), d.at ?? Infinity]));
	await update((list) => list.filter((c) => !(c.at <= (upTo.get(keyOf(c)) ?? -Infinity))));
}

/**
 * Etwas vormerken, das nicht über den Schreib-Haken kam.
 *
 * Für Entscheidungen, die der Abgleich selbst trifft, während er Fremdes
 * einspielt: dort schreibt er am Haken vorbei (`remoteStore`), und ohne diesen
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
	await update((list) => {
		let touched = false;
		const next = list.map((c) => {
			const rev = revs.get(keyOf(c));
			if (rev === undefined || c.rev === rev) return c;
			touched = true;
			return { ...c, rev };
		});
		return touched ? next : null;
	});
}

/**
 * Vorgemerkte Einträge ihrem neuen Monat zuordnen (`id -> Monat`).
 *
 * Der Abgleich sucht einen Eintrag in dem Monat, der hier vermerkt ist; findet
 * er ihn dort nicht, hält er ihn für gelöscht.
 */
export async function relocateChanges(moved: ReadonlyMap<string, string>): Promise<void> {
	if (moved.size === 0) return;
	await update((list) => {
		let touched = false;
		const next = list.map((c) => {
			const month = c.kind === "entry" ? moved.get(c.id) : undefined;
			if (month === undefined || c.month === month) return c;
			touched = true;
			return { ...c, month };
		});
		return touched ? next : null;
	});
}

/** Innerhalb dieses Fensters eine Änderung nach der anderen. */
const serial = createSerialQueue();

/**
 * outbox.json lesen, `change` anwenden und zurückschreiben – `null` heisst:
 * nichts zu schreiben. Über Fenster hinweg gesperrt (acrossWindows).
 */
function update(change: (list: PendingChange[]) => PendingChange[] | null): Promise<void> {
	const run = () =>
		acrossWindows("outbox", async () => {
			const onDisk = await readOutbox();
			const next = change(onDisk);
			pending = next ?? onDisk;
			if (next) await persist();
		});
	return serial(run);
}

async function readOutbox(): Promise<PendingChange[]> {
	try {
		return await loadOutbox<PendingChange>();
	} catch (e) {
		// Lieber mit dem letzten Stand weiter als mit einer leeren Liste, die das
		// Vorgemerkte beim nächsten Schreiben überschriebe.
		logWarn("Outbox nicht lesbar, nehme den letzten Stand", e);
		return pending;
	}
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
	await update((list) => mergePending(list, changes));
	onChange?.();
}

/** Den Abgleich scharf schalten. */
export async function startTracking(device: string): Promise<void> {
	deviceId = device;
	if (!loaded) {
		await refreshPending();
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
	// Ohne Konto beigetreten: die Mitgliedschaft liegt bisher nur auf diesem Gerät.
	const team = await remoteStore.team();
	if (team && (forceAll || team.rev === undefined)) {
		changes.push({ kind: "team", id: TEAM_RECORD_ID, deleted: false, at: now });
	}

	await note(changes);
}

/**
 * Eine Mitgliedschaft vormerken, die der Server noch nie gesehen hat - VOR dem
 * ersten Abruf, anders als der übrige ungestempelte Bestand. Sie trägt den
 * Zeitpunkt des Beitritts und tritt damit gegen den Stand des Kontos an; erst
 * nach dem Abruf wäre sie schon überschrieben.
 */
export async function rememberUnsyncedTeam(): Promise<void> {
	const team = await remoteStore.team();
	if (!team || team.rev !== undefined) return;
	await note([{ kind: "team", id: TEAM_RECORD_ID, deleted: false, at: Date.now() }]);
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
		const now = Date.now();
		const { changes, stamped } = diffAndStamp(before, after, deviceId, now, ENTRY_FIELDS);
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
			now,
			ACTIVITY_FIELDS
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
		const now = Date.now();
		// Die Einstellungen sind EIN Datensatz, kein Bestand – deshalb über eine
		// einelementige Liste mit fester Id statt über echte Identitäten.
		const wrap = (s: Settings | null) => (s ? [{ ...s, id: SETTINGS_ID }] : []);
		const fielded = stampFields(before as StampedSettings | null, after as StampedSettings, now, SETTINGS_FIELDS);
		const { changes, stamped } = diffAndStamp(wrap(before), wrap(fielded), deviceId, now);
		await note(changes.changed.map(() => ({ kind: "settings" as const, id: SETTINGS_ID, deleted: false, at: now })));
		// Die geliehene Id gehört nicht in die Datei zurück.
		const { id: _id, ...rest } = stamped[0];
		return rest as Settings;
	},

	timeReport: (month, before, after) => noteWhole("timereport", timeReportId(month), before, after),

	team: (before, after) => noteWhole("team", TEAM_RECORD_ID, before, after)
};

/**
 * Ein Datensatz, den es nur als Ganzes gibt (Report eines Monats,
 * Team-Mitgliedschaft): derselbe Kniff wie bei den Einstellungen - eine
 * einelementige Liste mit geliehener Id. `after === null` heisst: er fällt weg.
 */
async function noteWhole<T extends SyncMeta>(
	kind: RecordKind,
	id: string,
	before: T | null,
	after: T | null
): Promise<T | null> {
	const now = Date.now();
	const wrap = (r: T | null) => (r ? [{ ...r, id }] : []);
	const { changes, stamped } = diffAndStamp(wrap(before), wrap(after), deviceId, now);
	await note([
		...changes.changed.map(() => ({ kind, id, deleted: false, at: now })),
		...changes.deleted.map((r) => ({ kind, id, deleted: true, rev: r.rev, at: now }))
	]);
	if (stamped.length === 0) return null;
	const { id: _id, ...rest } = stamped[0];
	return rest as unknown as T;
}

/** Nur für Tests: den Modulzustand vergessen. */
export function resetOutboxForTests(): void {
	onChange = null;
	pending = [];
	loaded = false;
	deviceId = "";
	setWriteHook(null);
}
