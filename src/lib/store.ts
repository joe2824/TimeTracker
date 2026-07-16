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
	const target = `${DIR}/${file}`;
	const json = JSON.stringify(data, null, 2);
	// Bevorzugt atomar: temp-Datei + rename (überschreibt das Ziel atomar).
	// Falls rename nicht erlaubt/möglich ist, direkt schreiben – Speichern darf
	// nie fehlschlagen, sonst bliebe z.B. ein gestarteter Timer ungespeichert.
	const tmp = `${DIR}/.${file}.tmp`;
	try {
		await writeTextFile(tmp, json, baseOpts);
		await rename(tmp, target, {
			oldPathBaseDir: BaseDirectory.AppData,
			newPathBaseDir: BaseDirectory.AppData
		});
	} catch {
		await writeTextFile(target, json, baseOpts);
	}
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
/** Ob bereits eine settings.json existiert (false = erster Programmstart). */
export async function settingsFileExists(): Promise<boolean> {
	return exists(`${DIR}/settings.json`, baseOpts);
}
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
	// Ein leerer Monat hinterlaesst keine Datei: sonst bliebe eine "[]"-Datei liegen
	// und der Monat geisterte ohne Eintraege weiter durch die Monatsauswahl.
	if (entries.length === 0) {
		const path = `${DIR}/${entriesFile(month)}`;
		if (await exists(path, baseOpts)) await remove(path, baseOpts);
		return;
	}
	return writeJson(entriesFile(month), entries);
}

/** Alle Monats-Keys MIT Eintraegen, neueste zuerst. */
export async function listEntryMonths(): Promise<string[]> {
	await ensureDir();
	const dir = await readDir(DIR, baseOpts);
	const keys = dir
		.map((e) => e.name?.match(MONTH_FILE_RE)?.[1])
		.filter((m): m is string => m !== undefined);
	// Altlasten aus frueheren Versionen: leere "[]"-Dateien nicht mitlisten.
	const filled = await Promise.all(
		keys.map(async (m) => ((await loadEntries(m)).length > 0 ? m : null))
	);
	return filled.filter((m): m is string => m !== null).sort().reverse();
}

export interface StoredYear {
	year: number;
	/** Monate mit Eintraegen in diesem Jahr */
	months: number;
	/** Eintraege insgesamt – damit vor dem Loeschen sichtbar ist, was weg waere */
	entries: number;
}

/** Jahre mit Eintraegen, neueste zuerst, inkl. Umfang fuer die Loesch-Abfrage. */
export async function listEntryYears(): Promise<StoredYear[]> {
	const byYear = new Map<number, StoredYear>();
	for (const m of await listEntryMonths()) {
		const year = Number(m.slice(0, 4));
		const count = (await loadEntries(m)).length;
		const acc = byYear.get(year) ?? { year, months: 0, entries: 0 };
		acc.months += 1;
		acc.entries += count;
		byYear.set(year, acc);
	}
	return [...byYear.values()].sort((a, b) => b.year - a.year);
}

/** Alle Monatsdateien eines Jahres loeschen. Gibt die geloeschten Monate zurueck. */
export async function deleteYear(year: number): Promise<string[]> {
	await ensureDir();
	const deleted: string[] = [];
	const dir = await readDir(DIR, baseOpts);
	for (const e of dir) {
		const m = e.name?.match(MONTH_FILE_RE);
		if (m && m[1].startsWith(`${year}-`)) {
			await remove(`${DIR}/${e.name}`, baseOpts);
			deleted.push(m[1]);
		}
	}
	return deleted.sort();
}
