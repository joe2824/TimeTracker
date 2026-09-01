import { isTauri } from "./platform/env";
import {
	loadActivities,
	loadEntries,
	loadSettings,
	listEntryMonths,
	saveActivities,
	saveEntries,
	saveSettings
} from "./store";
import type { Activity, Entry, Settings } from "./types";
import { app } from "./app.svelte";
import { account } from "./sync/account.svelte";
import { invoke } from "@tauri-apps/api/core";
import { logError, logInfo } from "./log";

export interface TimeTrackerBackup {
	version: 1;
	format: "timetracker-backup";
	createdAt: string; // ISO 8601
	appVersion?: string;
	settings: Settings;
	activities: Activity[];
	entries: Record<string, Entry[]>; // "YYYY-MM" -> Entry[]
}

export interface BackupStats {
	activityCount: number;
	monthCount: number;
	entryCount: number;
	months: string[];
	createdAt?: string;
}

export interface RestoreResult {
	restoredActivities: number;
	restoredMonths: number;
	restoredEntries: number;
}

/**
 * Erstellt eine vollständige Sicherung aller lokalen Daten (Einstellungen, Aktivitäten, alle Monate).
 *
 * Solange nach einer Neuverknuepfung noch aeltere Monate nachkommen, waere die
 * Sicherung nur ein Ausschnitt - und sie sieht einer vollstaendigen zum
 * Verwechseln aehnlich. Dann lieber gar keine.
 */
export async function createBackupData(): Promise<TimeTrackerBackup> {
	if (account.backfilling) {
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
		entries
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
			createdAt: backup.createdAt
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

	// App-Zustand neu laden. Die wiederhergestellten Monate ausdruecklich dazu:
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
