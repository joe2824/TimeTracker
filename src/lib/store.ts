// Datei-basierte Persistenz ueber tauri-plugin-fs.
// Alle Daten liegen als JSON im App-Daten-Ordner unter "data/":
//   data/activities.json          (global)
//   data/settings.json            (global)
//   data/entries-YYYY-MM.json     (eine Datei pro Monat)
//   data/timereport-YYYY-MM.json  (eingelesener LOGA-Report, eine Datei pro Monat)
import {
	BaseDirectory,
	exists,
	mkdir,
	readDir,
	readTextFile,
	remove,
	rename,
	stat,
	writeTextFile
} from "@tauri-apps/plugin-fs";
import type { Activity, Entry, Settings } from "./types";
import type { TimeReportDay } from "./timeReport";
import { defaultSettings } from "./types";
import { logError, logWarn } from "./log";

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

/**
 * Je Datei ein Schreibvorgang zur Zeit; das jeweils letzte Versprechen haelt die
 * Schlange.
 *
 * Ohne das teilen sich zwei gleichzeitige Speicherungen derselben Datei ihre
 * Zwischendatei – und eine Reihenfolge davon endet mit dem AELTEREN Stand auf
 * der Platte: A schreibt tmp, B ueberschreibt tmp, B benennt um, A findet sein
 * tmp nicht mehr, faellt in den direkten Weg und schreibt seinen alten Stand
 * ueber B. Die Aenderung von B lebte danach nur noch im Speicher, bis irgendwann
 * das naechste Speichern kam. Gleichzeitig ist der Normalfall: die Schalter in
 * den Einstellungen rufen ihr save() ohne await.
 *
 * Erst seit die Zwischendatei ohne fuehrenden Punkt geschrieben wird (der Scope
 * des fs-Plugins liess versteckte Dateien nicht zu), greift der atomare Weg
 * ueberhaupt – vorher lief jedes Speichern direkt und die Luecke blieb
 * unsichtbar.
 */
const writeQueue = new Map<string, Promise<void>>();

/**
 * `op` erst laufen lassen, wenn der vorige Vorgang an dieser Datei fertig ist.
 * Die Aufrufer merken davon nichts: sie bekommen ihr Versprechen wie zuvor.
 */
function queued(file: string, op: () => Promise<void>): Promise<void> {
	const prev = writeQueue.get(file) ?? Promise.resolve();
	// Ein gescheiterter Vorgaenger darf den naechsten nicht mitreissen: dessen
	// Aufrufer hat seinen Fehler schon bekommen.
	const next = prev.then(op, op);
	writeQueue.set(file, next);
	void next.catch(() => {}).then(() => {
		// Nur wegraeumen, wenn seitdem nichts Neues angehaengt wurde.
		if (writeQueue.get(file) === next) writeQueue.delete(file);
	});
	return next;
}

function writeJson(file: string, data: unknown): Promise<void> {
	return queued(file, () => writeJsonNow(file, data));
}

/**
 * Der Abgleich klinkt sich hier ein, um jeden Schreibvorgang mitzubekommen.
 *
 * Der Haken laeuft INNERHALB der Warteschlange: er bekommt den Stand von der
 * Platte und gibt zurueck, was tatsaechlich geschrieben wird. Damit sieht er
 * jede Aenderung genau einmal und in der richtigen Reihenfolge – auch die des
 * anderen Fensters, das sich dieselben Dateien teilt.
 *
 * Ohne verknuepftes Konto ist er null und dieses Modul verhaelt sich Zeile fuer
 * Zeile wie zuvor. Das ist Absicht: die Serveranbindung ist ein Zusatz, kein
 * Umbau des lokalen Betriebs.
 */
export interface WriteHook {
	entries(month: string, before: Entry[], after: Entry[]): Promise<Entry[]>;
	activities(before: Activity[], after: Activity[]): Promise<Activity[]>;
	settings(before: Settings | null, after: Settings): Promise<Settings>;
}

let writeHook: WriteHook | null = null;

export function setWriteHook(hook: WriteHook | null): void {
	writeHook = hook;
}

async function writeJsonNow(file: string, data: unknown): Promise<void> {
	await ensureDir();
	const target = `${DIR}/${file}`;
	const json = JSON.stringify(data, null, 2);
	// Bevorzugt atomar: temp-Datei + rename (überschreibt das Ziel atomar).
	// Falls rename nicht erlaubt/möglich ist, direkt schreiben – Speichern darf
	// nie fehlschlagen, sonst bliebe z.B. ein gestarteter Timer ungespeichert.
	//
	// OHNE fuehrenden Punkt: der Scope des fs-Plugins ($APPDATA/**) laesst keine
	// versteckten Dateien zu. Mit ".settings.json.tmp" scheiterte JEDER Schreib-
	// versuch mit "forbidden path", und jedes Speichern lief im Fallback unten –
	// der atomare Weg war damit seit jeher tot, auf allen Plattformen.
	const tmp = `${DIR}/${file}.tmp`;
	try {
		await writeTextFile(tmp, json, baseOpts);
		await rename(tmp, target, {
			oldPathBaseDir: BaseDirectory.AppData,
			newPathBaseDir: BaseDirectory.AppData
		});
	} catch (e) {
		// Der unsichere Weg: ab hier kann ein Stromausfall eine halbe Datei
		// hinterlassen. Wenn das dauerhaft passiert, steht der Grund im Protokoll.
		logWarn(`${file}: atomares Schreiben nicht möglich, schreibe direkt`, e);
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

function entriesFile(month: string): string {
	return `entries-${month}.json`;
}

const MONTH_FILE_RE = /^entries-(\d{4}-\d{2})\.json$/;
const REPORT_FILE_RE = /^timereport-(\d{4}-\d{2})\.json$/;

/**
 * Dateien im Datenordner, deren Name auf `re` passt: [Dateiname, Monat].
 *
 * Monatsliste, Report-Liste, Aufraeumen und Jahr-Loeschen lasen dafuer vorher
 * jede fuer sich das Verzeichnis und liefen mit derselben Schleife darueber.
 */
async function dataFiles(re: RegExp): Promise<[string, string][]> {
	await ensureDir();
	const hits: [string, string][] = [];
	for (const e of await readDir(DIR, baseOpts)) {
		const m = e.name?.match(re);
		if (m) hits.push([e.name, m[1]]);
	}
	return hits;
}

// ---- Aktivitaeten ----
export async function loadActivities(): Promise<Activity[]> {
	return readJson<Activity[]>("activities.json", []);
}
export async function saveActivities(activities: Activity[]): Promise<void> {
	if (!writeHook) return writeJson("activities.json", activities);
	return queued("activities.json", async () => {
		const before = await readJson<Activity[]>("activities.json", []);
		await writeJsonNow("activities.json", await writeHook!.activities(before, activities));
	});
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
	if (!writeHook) return writeJson("settings.json", settings);
	return queued("settings.json", async () => {
		const before = await readJson<Settings | null>("settings.json", null);
		await writeJsonNow("settings.json", await writeHook!.settings(before, settings));
	});
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
		logError(`${file} ist beschädigt, abgelegt als ${quarantine}`, e);
		try {
			await rename(path, quarantine, {
				oldPathBaseDir: BaseDirectory.AppData,
				newPathBaseDir: BaseDirectory.AppData
			});
		} catch (renameErr) {
			logError("Beschädigte Datei konnte nicht abgelegt werden", renameErr);
		}
		return [];
	}
}
export async function saveEntries(month: string, entries: Entry[]): Promise<void> {
	// Ein leerer Monat hinterlaesst keine Datei: sonst bliebe eine "[]"-Datei liegen
	// und der Monat geisterte ohne Eintraege weiter durch die Monatsauswahl.
	//
	// Auch das Loeschen geht durch die Warteschlange: sonst raeumte es die Datei
	// weg, waehrend ein Speichern desselben Monats noch laeuft – und der Monat
	// stuende danach wieder da, mit dem Eintrag, den gerade jemand entfernt hat.
	const file = entriesFile(month);
	if (entries.length === 0) {
		return queued(file, async () => {
			const path = `${DIR}/${file}`;
			// Auch das Leeren geht durch den Haken: sonst verschwaende ein
			// geleerter Monat, ohne dass der Abgleich die Loeschungen je erfaehrt.
			if (writeHook) await writeHook.entries(month, await readEntriesRaw(month), []);
			if (await exists(path, baseOpts)) await remove(path, baseOpts);
		});
	}
	if (!writeHook) return writeJson(file, entries);
	return queued(file, async () => {
		const before = await readEntriesRaw(month);
		await writeJsonNow(file, await writeHook!.entries(month, before, entries));
	});
}

/**
 * Der Stand einer Monatsdatei ohne die Quarantaene-Behandlung von `loadEntries`.
 *
 * Der Haken braucht den Vergleichsstand INNERHALB der Warteschlange – und dort
 * darf nichts umbenannt werden, waehrend gleich darauf geschrieben wird. Eine
 * unlesbare Datei gilt hier als "kein Vorstand": das Speichern faellt dann auf
 * den Fall "alles neu" zurueck und laedt lieber zu viel hoch als zu wenig.
 */
async function readEntriesRaw(month: string): Promise<Entry[]> {
	return readJson<Entry[]>(entriesFile(month), []);
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
	return (await dataFiles(MONTH_FILE_RE)).map(([, month]) => month).sort().reverse();
}

/** Bis hierhin kann eine Monatsdatei leer sein ("[]"); ein Eintrag braucht ueber 150 Zeichen. */
const EMPTY_MONTH_MAX_BYTES = 64;

/**
 * Beim Start: leere "[]"-Monatsdateien entfernen, die fruehere Versionen liegen
 * liessen. Ohne das geisterten die Monate ohne Eintraege durch die Auswahl.
 *
 * Gelesen wird nur, was klein genug ist, um leer zu sein. Vorher zog dieser
 * Schritt bei JEDEM Start den kompletten Bestand durch JSON.parse – wachsend mit
 * jedem Monat, der je existierte, und noch vor dem ersten Bild.
 *
 * Eine beschaedigte Datei ueber der Grenze faellt damit nicht mehr hier auf,
 * sondern beim Laden ihres Monats – `loadEntries` legt sie dort ohnehin zur Seite.
 */
export async function pruneEmptyMonthFiles(): Promise<string[]> {
	const pruned: string[] = [];
	for (const [name, month] of await dataFiles(MONTH_FILE_RE)) {
		// Metadaten statt Inhalt. Antwortet das Dateisystem nicht, bleibt die Datei
		// liegen – geloescht wird nur, was nachweislich leer ist.
		const bytes = await stat(`${DIR}/${name}`, baseOpts)
			.then((info) => info.size)
			.catch(() => Number.MAX_SAFE_INTEGER);
		if (bytes > EMPTY_MONTH_MAX_BYTES) continue;
		if ((await loadEntries(month)).length === 0) {
			await remove(`${DIR}/${name}`, baseOpts);
			pruned.push(month);
		}
	}
	return pruned.sort();
}

// ---- Zeitwirtschaftsreport (pro Monat) ----

/** Ein eingelesener LOGA-Report, auf einen Monat und eine Person eingedampft. */
export interface StoredTimeReport {
	/** "YYYY-MM" */
	month: string;
	/** Wann die Datei eingelesen wurde (Epoch-ms) */
	importedAt: number;
	/** Person aus der Datei – bei einem Team-Export gibt es mehrere zur Auswahl. */
	personKey: string;
	personName: string;
	/** Nur die Tage DIESES Monats, aufsteigend. */
	days: TimeReportDay[];
}

function reportFile(month: string): string {
	return `timereport-${month}.json`;
}

/** Den gespeicherten Report eines Monats lesen. Null, wenn keiner vorliegt. */
export async function loadTimeReport(month: string): Promise<StoredTimeReport | null> {
	const stored = await readJson<StoredTimeReport | null>(reportFile(month), null);
	// Eine Datei aus einer aelteren/kaputten Fassung soll die Ansicht nicht kippen.
	return stored && Array.isArray(stored.days) ? stored : null;
}

export async function saveTimeReport(report: StoredTimeReport): Promise<void> {
	return writeJson(reportFile(report.month), report);
}

/**
 * Monate, zu denen ein eingelesener Report auf der Platte liegt, aufsteigend.
 *
 * Damit der Abgleich den Monat wechseln kann, ohne dass die Datei noch offen ist –
 * sonst muesste man ihn schliessen, den Monat in der Eintraege-Ansicht umstellen
 * und ihn wieder oeffnen.
 */
export async function listTimeReportMonths(): Promise<string[]> {
	return (await dataFiles(REPORT_FILE_RE)).map(([, month]) => month).sort();
}

// ---- Geraet und Abgleich ----

/**
 * Was dieses Geraet ueber sich und seine Verknuepfung weiss.
 *
 * Bewusst NICHT in settings.json: dort landet alles in jedem Backup und in jedem
 * Fehlerbericht. Hier kommen spaeter das Geraete-Token und der verpackte
 * Schluessel dazu – beides gehoert nicht in eine Datei, die man beilaeufig
 * weitergibt.
 */
export interface DeviceInfo {
	/** Zufaellige, dauerhafte Kennung dieses Geraets. */
	id: string;
}

export async function loadDevice(): Promise<DeviceInfo | null> {
	return readJson<DeviceInfo | null>("device.json", null);
}

export async function saveDevice(info: DeviceInfo): Promise<void> {
	return writeJson("device.json", info);
}

/** Ausstehende Aenderungen. Der Inhalt steht in sync/outbox.ts. */
export async function loadOutbox<T>(): Promise<T[]> {
	const stored = await readJson<T[]>("outbox.json", []);
	return Array.isArray(stored) ? stored : [];
}

export async function saveOutbox<T>(changes: T[]): Promise<void> {
	return writeJson("outbox.json", changes);
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

/**
 * Alle Monatsdateien eines Jahres loeschen. Gibt die geloeschten Monate zurueck.
 *
 * Die eingelesenen LOGA-Reports des Jahres gehen mit: sie enthalten dieselben
 * Arbeitszeiten wie die Eintraege selbst. Wer ein Jahr entfernt, will nicht,
 * dass der Abgleich es danach weiter kennt.
 */
export async function deleteYear(year: number): Promise<string[]> {
	const removeYear = async (re: RegExp) => {
		const hits = (await dataFiles(re)).filter(([, month]) => month.startsWith(`${year}-`));
		for (const [name] of hits) await remove(`${DIR}/${name}`, baseOpts);
		return hits.map(([, month]) => month);
	};
	const deleted = await removeYear(MONTH_FILE_RE);
	await removeYear(REPORT_FILE_RE);
	return deleted.sort();
}
