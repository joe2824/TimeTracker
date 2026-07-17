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
		// Die temp-Datei liegt sonst fuer immer im Datenordner – und zwar bei
		// JEDEM Speichern erneut, solange rename scheitert.
		try {
			if (await exists(tmp, baseOpts)) await remove(tmp, baseOpts);
		} catch {
			/* Aufraeumen darf das Speichern nicht kippen */
		}
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
/**
 * Eintraege eines Monats lesen.
 *
 * Eine beschaedigte Datei wird NICHT als "leer" behandelt, sondern zur Seite
 * gelegt: readJson verschluckt Parse-Fehler und liefert [] – pruneEmptyMonthFiles
 * haette die Datei damit fuer leer gehalten und beim naechsten Start geloescht,
 * ebenso der naechste Speichervorgang. Ein halb geschriebener Monat (Stromausfall
 * im Fallback-Zweig von writeJson) waere so lautlos komplett verloren.
 */
export async function loadEntries(month: string): Promise<Entry[]> {
	const file = entriesFile(month);
	const path = `${DIR}/${file}`;
	if (!(await exists(path, baseOpts))) return [];
	const txt = await readTextFile(path, baseOpts);
	if (!txt.trim()) return [];
	try {
		return JSON.parse(txt) as Entry[];
	} catch (e) {
		// Umbenennen statt loeschen – der Name passt dann nicht mehr auf
		// MONTH_FILE_RE, wird also weder gelistet noch aufgeraeumt.
		const quarantine = `${path}.beschaedigt-${Date.now()}`;
		console.error(`${file} ist beschaedigt, abgelegt als ${quarantine}`, e);
		try {
			await rename(path, quarantine, {
				oldPathBaseDir: BaseDirectory.AppData,
				newPathBaseDir: BaseDirectory.AppData
			});
		} catch (renameErr) {
			console.error("Beschaedigte Datei konnte nicht abgelegt werden", renameErr);
		}
		return [];
	}
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

/**
 * Alle Monats-Keys mit Eintraegen, neueste zuerst.
 *
 * Liest nur das Verzeichnis: seit `saveEntries` leere Monate loescht, bedeutet
 * "Datei da" = "hat Eintraege". Altlasten aus frueheren Versionen raeumt
 * `pruneEmptyMonthFiles()` einmalig beim Start weg – diese Funktion laeuft nach
 * jedem Speichern und darf nicht jedes Mal den ganzen Bestand einlesen.
 */
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

/**
 * Einmalig beim Start: leere "[]"-Monatsdateien entfernen, die fruehere Versionen
 * liegen liessen. Ohne das geisterten die Monate ohne Eintraege durch die Auswahl.
 */
export async function pruneEmptyMonthFiles(): Promise<string[]> {
	await ensureDir();
	const dir = await readDir(DIR, baseOpts);
	const pruned: string[] = [];
	for (const e of dir) {
		const m = e.name?.match(MONTH_FILE_RE);
		if (!m) continue;
		if ((await loadEntries(m[1])).length === 0) {
			await remove(`${DIR}/${e.name}`, baseOpts);
			pruned.push(m[1]);
		}
	}
	return pruned.sort();
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
