// Datei-basierte Persistenz ueber tauri-plugin-fs.
// Alle Daten liegen als JSON im App-Daten-Ordner unter "data/":
//   data/activities.json          (global)
//   data/settings.json            (global)
//   data/entries-YYYY-MM.json     (eine Datei pro Monat)
//   data/timereport-YYYY-MM.json  (eingelesener LOGA-Report, eine Datei pro Monat)
import { storage } from "./platform/fs";
import type { Activity, Entry, Settings } from "./types";
import type { TimeReportDay } from "./timeReport";
import type { SyncPriority } from "./sync/engine";
import { defaultSettings } from "./types";
import { logError, logWarn } from "./log";

const DIR = "data";

async function ensureDir(): Promise<void> {
	if (!(await storage.exists(DIR))) await storage.mkdir(DIR);
}

async function readJson<T>(file: string, fallback: T): Promise<T> {
	const path = `${DIR}/${file}`;
	if (!(await storage.exists(path))) return fallback;
	try {
		const txt = await storage.readTextFile(path);
		return txt.trim() ? (JSON.parse(txt) as T) : fallback;
	} catch {
		return fallback;
	}
}

/**
 * Je Datei ein Schreibvorgang zur Zeit; das jeweils letzte Versprechen haelt die
 * Schlange.
 *
 * Ohne das teilen sich zwei gleichzeitige Speicherungen ihre .tmp-Datei, und eine
 * Reihenfolge davon endet mit dem AELTEREN Stand auf der Platte.
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
 * Laeuft INNERHALB der Warteschlange: damit sieht er jede Aenderung genau einmal
 * und in der richtigen Reihenfolge.
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
	const tmp = `${DIR}/${file}.tmp`;
	try {
		await storage.writeTextFile(tmp, json);
		await storage.rename(tmp, target);
	} catch (e) {
		// Der unsichere Weg: ab hier kann ein Stromausfall eine halbe Datei
		// hinterlassen. Wenn das dauerhaft passiert, steht der Grund im Protokoll.
		logWarn(`${file}: atomares Schreiben nicht möglich, schreibe direkt`, e);
		await storage.writeTextFile(target, json);
		// Die temp-Datei liegt sonst fuer immer im Datenordner – und zwar bei
		// JEDEM Speichern erneut, solange rename scheitert.
		try {
			if (await storage.exists(tmp)) await storage.remove(tmp);
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

/** Dateien im Datenordner, deren Name auf `re` passt: [Dateiname, Monat]. */
async function dataFiles(re: RegExp): Promise<[string, string][]> {
	await ensureDir();
	const hits: [string, string][] = [];
	for (const e of await storage.readDir(DIR)) {
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
	return storage.exists(`${DIR}/settings.json`);
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
/** Eintraege eines Monats lesen. */
export async function loadEntries(month: string): Promise<Entry[]> {
	const file = entriesFile(month);
	const path = `${DIR}/${file}`;
	if (!(await storage.exists(path))) return [];
	const txt = await storage.readTextFile(path);
	if (!txt.trim()) return [];
	try {
		return JSON.parse(txt) as Entry[];
	} catch (e) {
		// Eine beschaedigte Datei darf NICHT als "leer" durchgehen: pruneEmptyMonthFiles
		// und der naechste Speichervorgang haetten sie sonst geloescht.
		// Umbenennen statt loeschen – der Name passt dann nicht mehr auf
		// MONTH_FILE_RE, wird also weder gelistet noch aufgeraeumt.
		const quarantine = `${path}.beschaedigt-${Date.now()}`;
		logError(`${file} ist beschädigt, abgelegt als ${quarantine}`, e);
		try {
			await storage.rename(path, quarantine);
		} catch (renameErr) {
			logError("Beschädigte Datei konnte nicht abgelegt werden", renameErr);
		}
		return [];
	}
}
export async function saveEntries(month: string, entries: Entry[]): Promise<void> {
	// Ein leerer Monat hinterlaesst keine Datei: sonst bliebe eine "[]"-Datei liegen
	// und der Monat geisterte ohne Eintraege weiter durch die Monatsauswahl.
	const file = entriesFile(month);
	if (entries.length === 0) {
		return queued(file, async () => {
			const path = `${DIR}/${file}`;
			// Auch das Leeren geht durch den Haken: sonst verschwaende ein
			// geleerter Monat, ohne dass der Abgleich die Loeschungen je erfaehrt.
			if (writeHook) await writeHook.entries(month, await readEntriesRaw(month), []);
			if (await storage.exists(path)) await storage.remove(path);
		});
	}
	if (!writeHook) return writeJson(file, entries);
	return queued(file, async () => {
		const before = await readEntriesRaw(month);
		await writeJsonNow(file, await writeHook!.entries(month, before, entries));
	});
}

/** Der Stand einer Monatsdatei ohne die Quarantaene-Behandlung von `loadEntries`. */
async function readEntriesRaw(month: string): Promise<Entry[]> {
	return readJson<Entry[]>(entriesFile(month), []);
}

/** Alle Monats-Keys mit Eintraegen, neueste zuerst. */
export async function listEntryMonths(): Promise<string[]> {
	return (await dataFiles(MONTH_FILE_RE)).map(([, month]) => month).sort().reverse();
}

/** Bis hierhin kann eine Monatsdatei leer sein ("[]"); ein Eintrag braucht ueber 150 Zeichen. */
const EMPTY_MONTH_MAX_BYTES = 64;

/**
 * Beim Start: leere "[]"-Monatsdateien entfernen, die fruehere Versionen liegen
 * liessen. Ohne das geisterten die Monate ohne Eintraege durch die Auswahl.
 */
export async function pruneEmptyMonthFiles(): Promise<string[]> {
	const pruned: string[] = [];
	for (const [name, month] of await dataFiles(MONTH_FILE_RE)) {
		// Metadaten statt Inhalt. Antwortet das Dateisystem nicht, bleibt die Datei
		// liegen – geloescht wird nur, was nachweislich leer ist.
		const bytes = await storage
			.stat(`${DIR}/${name}`)
			.then((info) => info.size)
			.catch(() => Number.MAX_SAFE_INTEGER);
		if (bytes > EMPTY_MONTH_MAX_BYTES) continue;
		if ((await loadEntries(month)).length === 0) {
			await storage.remove(`${DIR}/${name}`);
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

/** Monate, zu denen ein eingelesener Report auf der Platte liegt, aufsteigend. */
export async function listTimeReportMonths(): Promise<string[]> {
	return (await dataFiles(REPORT_FILE_RE)).map(([, month]) => month).sort();
}

// ---- Geraet und Abgleich ----

/**
 * Was dieses Geraet ueber sich und seine Verknuepfung weiss.
 *
 * Eigene Datei, bewusst NICHT settings.json: Token und Tresorschluessel gehoeren
 * nicht in etwas, das in jedem Backup und jedem Fehlerbericht landet.
 */
export interface DeviceInfo {
	/** Zufaellige, dauerhafte Kennung dieses Geraets. */
	id: string;
	/** Adresse des Servers, z.B. "https://tracker.example.de". */
	serverUrl?: string;
	/** Das Geraete-Token, geschuetzt ueber das Betriebssystem (siehe secret.rs). */
	token?: string;
	/** Der Tresorschluessel, ebenso geschuetzt. */
	vaultKey?: string;
	/** Ob Token und Schluessel wirklich vom Betriebssystem geschuetzt sind. */
	protected?: boolean;
	/** Bis zu welchem Serverstand dieses Geraet alles kennt. */
	seq?: number;
	/** Der vorgezogene Teil des Abgleichs - nur da, solange Historie fehlt. */
	priority?: SyncPriority;
	/** Anzeigename des Kontos - nur fuer die Oberflaeche. */
	accountName?: string;
	/**
	 * Welches Konto hier haengt - der Nachweis aus seinem Tresorschluessel.
	 *
	 * Zwei Konten haben verschiedene Schluessel, also verschiedene Nachweise.
	 * Damit laesst sich ein Kontowechsel erkennen, ohne die Kontokennung selbst
	 * abzulegen.
	 */
	kontoKennung?: string;
	/**
	 * Wem der lokale Bestand gehoert.
	 *
	 * Weicht das von `kontoKennung` ab, stammen die Daten aus einem ANDEREN
	 * Konto - dann duerfen sie nicht in das jetzige hochgeladen werden. Fehlt der
	 * Wert, hat dieses Geraet noch nie ein Konto gesehen: der Bestand ist dann
	 * der eigene und gehoert hoch.
	 */
	bestandGehoertZu?: string;
}

/**
 * Alles loeschen, was zu einem Konto gehoert – Eintraege, Aktivitaeten, Outbox,
 * Einstellungen und eingelesene Reports.
 *
 * Fuer den Browser und bei Kontowechsel: dort ist der lokale Bestand nur die
 * Kopie eines Kontos. Bleiben Daten liegen, sieht der naechste Mensch die Zeiten
 * und Einstellungen des vorigen – und schlimmer: sie wandern beim naechsten
 * Abgleich in SEIN Konto.
 */
export async function clearAccountData(): Promise<void> {
	for (const monat of await listEntryMonths()) {
		const pfad = `${DIR}/${entriesFile(monat)}`;
		if (await storage.exists(pfad)) await storage.remove(pfad);
	}
	for (const monat of await listTimeReportMonths()) {
		const pfad = `${DIR}/${reportFile(monat)}`;
		if (await storage.exists(pfad)) await storage.remove(pfad);
	}
	for (const datei of ["activities.json", "outbox.json", "settings.json"]) {
		const pfad = `${DIR}/${datei}`;
		if (await storage.exists(pfad)) await storage.remove(pfad);
	}
}

/**
 * Die Merkliste leeren - was darin steht, gehoert dem vorigen Konto.
 *
 * Getrennt von `clearAccountData`, weil sie auch dort weg muss, wo die Zeiten
 * bleiben sollen: der Abgleich liest die Outbox und fragt dabei keinen Stempel.
 */
export async function clearOutbox(): Promise<void> {
	const pfad = `${DIR}/outbox.json`;
	if (await storage.exists(pfad)) await storage.remove(pfad);
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

/** Alle Monatsdateien eines Jahres loeschen. Gibt die geloeschten Monate zurueck. */
export async function deleteYear(year: number): Promise<string[]> {
	const desJahres = async (re: RegExp) =>
		(await dataFiles(re)).filter(([, month]) => month.startsWith(`${year}-`));

	// Die Monate gehen ueber saveEntries(month, []) und NICHT ueber ein direktes
	// storage.remove(): nur so laeuft die Loeschung durch den Haken und landet in
	// der Outbox - sonst faende der naechste Abgleich die Monate beim Server
	// unveraendert vor und laedt das geloeschte Jahr wieder herunter.
	const monate = (await desJahres(MONTH_FILE_RE)).map(([, month]) => month);
	for (const month of monate) await saveEntries(month, []);

	// Die eingelesenen LOGA-Reports gleicht niemand ab; sie duerfen direkt weg -
	// aber durch die Warteschlange, aus demselben Grund wie das Leeren eines Monats
	// in saveEntries: ein noch anstehendes saveTimeReport derselben Datei legte sie
	// sonst NACH dem Loeschen wieder an, unsichtbar bis zum naechsten Start.
	for (const [name] of await desJahres(REPORT_FILE_RE)) {
		await queued(name, async () => {
			const path = `${DIR}/${name}`;
			if (await storage.exists(path)) await storage.remove(path);
		});
	}
	return monate.sort();
}
