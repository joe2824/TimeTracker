// Datei-basierte Persistenz ueber tauri-plugin-fs.
// Alle Daten liegen als JSON im App-Daten-Ordner unter "data/":
//   data/activities.json          (global)
//   data/settings.json            (global)
//   data/entries-YYYY-MM.json     (eine Datei pro Monat)
import {
	BaseDirectory,
	exists,
	mkdir,
	readDir,
	readTextFile,
	remove,
	rename,
	writeTextFile
} from "@tauri-apps/plugin-fs";
import type { Activity, Entry, Settings } from "./types";
import { defaultSettings } from "./types";

const DIR = "data";
const baseOpts = { baseDir: BaseDirectory.AppData } as const;

async function ensureDir(): Promise<void> {
	if (!(await exists(DIR, baseOpts))) {
		await mkdir(DIR, { baseDir: BaseDirectory.AppData, recursive: true });
	}
}

async function readJson<T>(file: string, fallback: T): Promise<T> {
	const path = `${DIR}/${file}`;
	if (!(await exists(path, baseOpts))) return fallback;
	try {
		const txt = await readTextFile(path, baseOpts);
		return txt.trim() ? (JSON.parse(txt) as T) : fallback;
	} catch {
		return fallback;
	}
}

async function writeJson(file: string, data: unknown): Promise<void> {
	await ensureDir();
	// Atomar schreiben: erst in eine temp-Datei, dann per rename ersetzen.
	// So bleibt bei einem Absturz mitten im Schreiben die alte Datei intakt
	// (std::fs::rename überschreibt das Ziel auf Windows wie Unix atomar).
	const target = `${DIR}/${file}`;
	const tmp = `${DIR}/.${file}.tmp`;
	await writeTextFile(tmp, JSON.stringify(data, null, 2), baseOpts);
	await rename(tmp, target, {
		oldPathBaseDir: BaseDirectory.AppData,
		newPathBaseDir: BaseDirectory.AppData
	});
}

/** "YYYY-MM" fuer einen Zeitstempel (Lokalzeit). */
export function monthKey(ts: number): string {
	const d = new Date(ts);
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function entriesFile(month: string): string {
	return `entries-${month}.json`;
}

const MONTH_FILE_RE = /^entries-(\d{4}-\d{2})\.json$/;

// ---- Aktivitaeten ----
export async function loadActivities(): Promise<Activity[]> {
	return readJson<Activity[]>("activities.json", []);
}
export async function saveActivities(activities: Activity[]): Promise<void> {
	return writeJson("activities.json", activities);
}

// ---- Einstellungen ----
export async function loadSettings(): Promise<Settings> {
	const stored = await readJson<Partial<Settings>>("settings.json", {});
	return { ...defaultSettings, ...stored };
}
export async function saveSettings(settings: Settings): Promise<void> {
	return writeJson("settings.json", settings);
}

// ---- Eintraege (pro Monat) ----
export async function loadEntries(month: string): Promise<Entry[]> {
	return readJson<Entry[]>(entriesFile(month), []);
}
export async function saveEntries(month: string, entries: Entry[]): Promise<void> {
	return writeJson(entriesFile(month), entries);
}

/** Alle vorhandenen Monats-Keys, neueste zuerst. */
export async function listEntryMonths(): Promise<string[]> {
	await ensureDir();
	const dir = await readDir(DIR, baseOpts);
	const months: string[] = [];
	for (const e of dir) {
		const m = e.name?.match(MONTH_FILE_RE);
		if (m) months.push(m[1]);
	}
	return months.sort().reverse();
}

/** Monatsdateien aelter als `keepMonths` Monate loeschen. */
export async function cleanupOldMonths(keepMonths = 12): Promise<string[]> {
	await ensureDir();
	const cutoff = new Date();
	cutoff.setMonth(cutoff.getMonth() - keepMonths);
	const cutoffKey = monthKey(cutoff.getTime());
	const deleted: string[] = [];
	const dir = await readDir(DIR, baseOpts);
	for (const e of dir) {
		const m = e.name?.match(MONTH_FILE_RE);
		if (m && m[1] < cutoffKey) {
			await remove(`${DIR}/${e.name}`, baseOpts);
			deleted.push(m[1]);
		}
	}
	return deleted;
}
