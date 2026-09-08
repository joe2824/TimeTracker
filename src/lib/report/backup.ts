import { isTauri } from "../platform/env";
import { storage } from "../platform/fs";
import {
	loadActivities,
	loadEntries,
	loadSettings,
	listEntryMonths,
	saveActivities,
	saveEntries,
	saveSettings
} from "../store";
import type { Activity, Entry, Settings } from "../types";
import { app } from "../app.svelte";
import { account } from "../sync/account.svelte";
import { invoke } from "@tauri-apps/api/core";
import { logError, logInfo, logWarn } from "../log";

export interface TimeTrackerBackup {
	version: 1;
	format: "timetracker-backup";
	createdAt: string; // ISO 8601
	appVersion?: string;
	settings: Settings;
	activities: Activity[];
	entries: Record<string, Entry[]>; // "YYYY-MM" -> Entry[]
	/**
	 * Dass beim Sichern der ganze Bestand da war. Älteren Dateien fehlt der
	 * Vermerk - die können aus einer Zeit stammen, in der noch Monate nachkamen.
	 */
	complete?: true;
}

export interface BackupStats {
	activityCount: number;
	monthCount: number;
	entryCount: number;
	months: string[];
	createdAt?: string;
	/** Ob die Datei bezeugt, dass sie den ganzen Bestand enthält. */
	complete: boolean;
}

export interface RestoreResult {
	restoredActivities: number;
	restoredMonths: number;
	restoredEntries: number;
}

/**
 * Erstellt eine vollständige Sicherung aller lokalen Daten (Einstellungen, Aktivitäten, alle Monate).
 *
 * Solange nach einer Neuverknüpfung noch ältere Monate nachkommen, wäre die
 * Sicherung nur ein Ausschnitt - und sie sieht einer vollständigen zum
 * Verwechseln ähnlich. Dann lieber gar keine.
 */
export async function createBackupData(): Promise<TimeTrackerBackup> {
	if (account.historyIncomplete) {
		throw new Error(
			"Ältere Monate werden gerade noch geladen. Die Sicherung wäre unvollständig – bitte kurz warten."
		);
	}
	const settings = await loadSettings();
	const activities = await loadActivities();
	const months = await listEntryMonths();

	const entries: Record<string, Entry[]> = {};
	for (const m of months) {
		const monthEntries = await loadEntries(m);
		if (monthEntries.length > 0) {
			entries[m] = monthEntries;
		}
	}

	return {
		version: 1,
		format: "timetracker-backup",
		createdAt: new Date().toISOString(),
		settings,
		activities,
		entries,
		complete: true
	};
}

/**
 * Prüft und berechnet Statistiken zu einer Sicherungsdatei.
 */
export function inspectBackup(jsonString: string): {
	valid: boolean;
	backup?: TimeTrackerBackup;
	stats?: BackupStats;
	error?: string;
} {
	try {
		const parsed = JSON.parse(jsonString) as Partial<TimeTrackerBackup>;
		if (!parsed || typeof parsed !== "object") {
			return { valid: false, error: "Die Datei enthält kein gültiges JSON-Objekt." };
		}

		// Prüfe Aktivitäten
		if (!Array.isArray(parsed.activities)) {
			return { valid: false, error: "Fehlende oder ungültige Aktivitätenliste in der Sicherung." };
		}

		// Prüfe Einstellungen
		if (!parsed.settings || typeof parsed.settings !== "object") {
			return { valid: false, error: "Fehlende Einstellungen in der Sicherung." };
		}

		// Prüfe Einträge
		if (!parsed.entries || typeof parsed.entries !== "object") {
			return { valid: false, error: "Fehlende Monatsdaten in der Sicherung." };
		}

		const backup = parsed as TimeTrackerBackup;
		const months = Object.keys(backup.entries).sort();
		let entryCount = 0;
		for (const m of months) {
			const list = backup.entries[m];
			if (Array.isArray(list)) {
				entryCount += list.length;
			}
		}

		const stats: BackupStats = {
			activityCount: backup.activities.length,
			monthCount: months.length,
			entryCount,
			months,
			createdAt: backup.createdAt,
			complete: backup.complete === true
		};

		return { valid: true, backup, stats };
	} catch (e) {
		return { valid: false, error: `JSON-Formatfehler: ${e instanceof Error ? e.message : String(e)}` };
	}
}

/**
 * Stellt eine Sicherung wieder her (entweder zusammenführend oder komplett ersetzend).
 */
export async function restoreBackup(
	backup: TimeTrackerBackup,
	mode: "merge" | "replace" = "merge"
): Promise<RestoreResult> {
	// Nachkommende Monate würden über das Eingespielte laufen: die Zeiten aus der
	// Datei tragen ihren alten Zeitstempel, der Serverstand gewinnt damit stellenweise.
	if (account.historyIncomplete) {
		throw new Error(
			"Ältere Monate werden gerade noch geladen. Ein Teil der Sicherung würde dabei wieder überschrieben – bitte kurz warten."
		);
	}

	let restoredActivities = 0;
	let restoredMonths = 0;
	let restoredEntries = 0;

	if (mode === "replace") {
		// 1. Einstellungen ersetzen
		await saveSettings(backup.settings);

		// 2. Aktivitäten ersetzen
		await saveActivities(backup.activities);
		restoredActivities = backup.activities.length;

		// 3. Vorhandene Monate, die in der Sicherung nicht vorkommen, leeren
		const currentMonths = await listEntryMonths();
		for (const cm of currentMonths) {
			if (!backup.entries[cm]) {
				await saveEntries(cm, []);
			}
		}

		// 4. Gesicherte Monate schreiben
		for (const [month, list] of Object.entries(backup.entries)) {
			if (Array.isArray(list)) {
				await saveEntries(month, list);
				restoredMonths++;
				restoredEntries += list.length;
			}
		}
	} else {
		// Modus: "merge" (Zusammenführen)

		// 1. Einstellungen zusammenführen (bestehende bevorzugen, fehlende ergänzen)
		const currentSettings = await loadSettings();
		const mergedSettings: Settings = { ...backup.settings, ...currentSettings };
		await saveSettings(mergedSettings);

		// 2. Aktivitäten zusammenführen (nach ID)
		const currentActivities = await loadActivities();
		const actMap = new Map<string, Activity>();
		for (const a of backup.activities) actMap.set(a.id, a);
		for (const a of currentActivities) actMap.set(a.id, a); // aktuelle überschreiben Backup-Stand bei gleicher ID
		const mergedActivities = Array.from(actMap.values());
		await saveActivities(mergedActivities);
		restoredActivities = mergedActivities.length;

		// 3. Monate zusammenführen
		for (const [month, backupList] of Object.entries(backup.entries)) {
			if (!Array.isArray(backupList) || backupList.length === 0) continue;
			const currentList = await loadEntries(month);
			const entryMap = new Map<string, Entry>();
			for (const e of backupList) entryMap.set(e.id, e);
			for (const e of currentList) entryMap.set(e.id, e); // aktuelle behalten

			const mergedList = Array.from(entryMap.values()).sort(
				(a, b) => a.startTs - b.startTs
			);
			await saveEntries(month, mergedList);
			restoredMonths++;
			restoredEntries += backupList.length;
		}
	}

	// App-Zustand neu laden. Die wiederhergestellten Monate ausdrücklich dazu:
	// `reload` liest von sich aus nur, was schon im Speicher steht.
	await app.reload(Object.keys(backup.entries));
	logInfo("Sicherung wiederhergestellt", { mode, restoredActivities, restoredMonths, restoredEntries });

	return { restoredActivities, restoredMonths, restoredEntries };
}

/**
 * Startet den Dateidownload / Speicher-Dialog für das Backup.
 */
export async function downloadBackupFile(): Promise<{ success: boolean; filename?: string; path?: string }> {
	try {
		const backup = await createBackupData();
		const json = JSON.stringify(backup, null, 2);
		const dateStr = new Date().toISOString().slice(0, 10);
		const defaultFilename = `timetracker-backup-${dateStr}.json`;

		if (isTauri()) {
			const { save } = await import("@tauri-apps/plugin-dialog");
			const filePath = await save({
				defaultPath: defaultFilename,
				filters: [{ name: "TimeTracker Sicherung", extensions: ["json"] }]
			});
			if (!filePath) return { success: false };

			await invoke("write_export_file", { path: filePath, contents: json });
			return { success: true, path: filePath, filename: defaultFilename };
		} else {
			// Web / PWA Download
			const blob = new Blob([json], { type: "application/json;charset=utf-8" });
			const url = URL.createObjectURL(blob);
			const a = document.createElement("a");
			a.href = url;
			a.download = defaultFilename;
			document.body.appendChild(a);
			a.click();
			document.body.removeChild(a);
			URL.revokeObjectURL(url);
			return { success: true, filename: defaultFilename };
		}
	} catch (e) {
		logError("Fehler beim Erstellen der Sicherungsdatei", e);
		throw e;
	}
}

/** Wo die automatischen Sicherungen liegen - NICHT unter `data`, das raeumt ein
 *  Kontowechsel weg. */
export const SNAPSHOT_DIR = "backups";
/** Mehr als das braucht niemand, und der Platz im Browser ist knapp. */
const KEEP_SNAPSHOTS = 3;

/**
 * Den Stand sichern, bevor eine Kopplung ihn ueberschreiben kann.
 *
 * Beim ersten Abgleich nach einer Kopplung gewinnt bei einem Konflikt die
 * neuere Fassung - und das kann eine eigene, noch nicht hochgeladene Aenderung
 * sein. Danach ist sie weg. Diese Datei ist der Weg zurueck; sie liegt im
 * Format des normalen Backups und laesst sich ueber "Sicherung einlesen"
 * zurueckholen.
 *
 * Wirft nie: eine fehlgeschlagene Sicherung darf das Koppeln nicht aufhalten.
 */
export async function snapshotBeforePairing(): Promise<string | null> {
	try {
		const backup = await createBackupData();
		if (backup.activities.length === 0 && Object.keys(backup.entries).length === 0) {
			// Nichts da, was verloren gehen koennte.
			return null;
		}
		await storage.mkdir(SNAPSHOT_DIR);
		const name = `vor-kopplung-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
		await storage.writeTextFile(`${SNAPSHOT_DIR}/${name}`, JSON.stringify(backup));
		await pruneSnapshots();
		logInfo("Sicherung vor der Kopplung angelegt", { name });
		return name;
	} catch (e) {
		logWarn("Sicherung vor der Kopplung nicht moeglich", e);
		return null;
	}
}

/** Die jüngste automatische Sicherung - oder null. */
export async function latestSnapshot(): Promise<{ name: string; at: number } | null> {
	try {
		const names = (await storage.readDir(SNAPSHOT_DIR)).map((e) => e.name).sort();
		const name = names[names.length - 1];
		if (!name) return null;
		const stamp = name.replace(/^vor-kopplung-/, "").replace(/\.json$/, "");
		// Aus "2026-09-07T17-04-05-123Z" wieder eine Zeit machen.
		const iso = stamp.replace(/-/g, (m, i) => (i > 9 ? ":" : "-")).replace(/:(\d{3})Z$/, ".$1Z");
		const at = Date.parse(iso);
		return { name, at: Number.isNaN(at) ? 0 : at };
	} catch {
		return null;
	}
}

async function pruneSnapshots(): Promise<void> {
	const names = (await storage.readDir(SNAPSHOT_DIR)).map((e) => e.name).sort();
	for (const name of names.slice(0, Math.max(0, names.length - KEEP_SNAPSHOTS))) {
		await storage.remove(`${SNAPSHOT_DIR}/${name}`).catch(() => {});
	}
}

/**
 * Eine automatische Sicherung einspielen.
 *
 * Im Modus "merge": fehlende Eintraege kommen zurueck, neuere bleiben stehen.
 * Ein Ueberschreiben waere hier falsch - der Server hat inzwischen recht.
 */
export async function restoreSnapshot(name: string): Promise<{
	restoredActivities: number;
	restoredMonths: number;
	restoredEntries: number;
}> {
	const json = await storage.readTextFile(`${SNAPSHOT_DIR}/${name}`);
	const check = inspectBackup(json);
	if (!check.valid) throw new Error(check.error ?? "Sicherung ist unlesbar");
	return restoreBackup(JSON.parse(json) as TimeTrackerBackup, "merge");
}

/** Beim Abmelden im Browser: die Sicherungen gehoeren dem vorigen Konto. */
export async function clearSnapshots(): Promise<void> {
	try {
		for (const { name } of await storage.readDir(SNAPSHOT_DIR)) {
			await storage.remove(`${SNAPSHOT_DIR}/${name}`).catch(() => {});
		}
	} catch {
		/* nichts da */
	}
}
