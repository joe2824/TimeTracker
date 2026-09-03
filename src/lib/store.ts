// Datei-basierte Persistenz ueber tauri-plugin-fs.
// Alle Daten liegen als JSON im App-Daten-Ordner unter "data/":
//   data/activities.json          (global)
//   data/settings.json            (global)
//   data/entries-YYYY-MM.json     (eine Datei pro Monat)
//   data/timereport-YYYY-MM.json  (eingelesener LOGA-Report, eine Datei pro Monat)
import { storage, usingBrowserStorage } from "./platform/fs";
import type { Activity, Entry, Settings, SyncMeta } from "./types";
import type { TimeReportDay, TimeReportFlag } from "./timeReport";
import type { SyncPriority } from "./sync/engine";
import { defaultSettings } from "./types";
import { logError, logWarn } from "./log";
import { openRecord, sealRecord } from "./crypto/vault";
import { loadLocalVaultKey } from "./platform/keyStore";

const DIR = "data";

async function ensureDir(): Promise<void> {
	if (!(await storage.exists(DIR))) await storage.mkdir(DIR);
}

// ---- Verschluesselung der lokalen Ablage (nur Browser) ----
//
// Auf dem Rechner schuetzt das Betriebssystem den App-Datenordner bereits.
// Im Browser liegt IndexedDB offen - fuer jede Erweiterung mit Speicherzugriff
// oder jeden zweiten Blick ins Profil. Verschluesselt wird mit demselben
// AES-GCM/JWE, das auch fuer den Server-Abgleich laeuft (sealRecord/
// openRecord, crypto/vault.ts) - hier mit `kind:"local"` gebunden an den
// Dateinamen, damit eine vertauschte Datei nicht unbemerkt durchgeht.
//
// `device.json` und `outbox.json` bleiben aussen vor (kein `encrypted`-Aufruf
// an ihren Lese-/Schreibstellen): `device.json` enthaelt den Schluessel selbst
// - zirkulaer -, `outbox.json` nur Referenzen, keine Inhalte.
let localKey: CryptoKey | null = null;

/** Den Schluessel setzen, mit dem die Browser-Ablage ver-/entschluesselt wird. */
export function setLocalEncryptionKey(key: CryptoKey | null): void {
	localKey = key;
}

function encryptsHere(): boolean {
	return usingBrowserStorage() && localKey !== null;
}

/** JWE-Compact-Strings bestehen nur aus Base64url und Punkten - nie aus "{" oder "[". */
function looksEncrypted(txt: string): boolean {
	const t = txt.trimStart();
	return t.length > 0 && t[0] !== "{" && t[0] !== "[";
}

async function encryptForStorage(file: string, data: unknown): Promise<string> {
	if (!encryptsHere()) return JSON.stringify(data, null, 2);
	return sealRecord(localKey!, data, { kind: "local", id: file, rev: 0 });
}

/**
 * Alte Dateien liegen noch als Klartext da - kein Fehler, sondern der Stand
 * vor dieser Aenderung. Sie werden beim naechsten Speichern verschluesselt
 * (siehe `app.svelte.ts`s einmaligem Nachhol-Durchlauf); bis dahin bleiben
 * sie lesbar.
 */
async function decryptFromStorage<T>(file: string, txt: string): Promise<T> {
	if (!looksEncrypted(txt)) return JSON.parse(txt) as T;
	if (!localKey) throw new Error(`${file} ist verschlüsselt, aber es liegt kein Schlüssel vor`);
	return openRecord<T>(localKey, txt, { kind: "local", id: file, rev: 0 });
}

/**
 * Beim Start: den Tresorschluessel aus der Geraetedatei vorladen, damit
 * verschluesselte Dateien gleich beim ersten Lesen aufgehen - unabhaengig
 * vom Konto-Abgleich, der erst danach anlaeuft und das Netz braucht (siehe
 * `app.svelte.ts`, `init()` laeuft vor `account.init()`).
 *
 * Nur im Browser: auf dem Rechner schuetzt das Betriebssystem den
 * Datenordner bereits.
 */
export async function preloadLocalEncryptionKey(): Promise<void> {
	if (!usingBrowserStorage()) return;
	try {
		setLocalEncryptionKey(await loadLocalVaultKey());
	} catch (e) {
		logWarn("Tresorschlüssel ließ sich beim Start nicht vorladen", e);
	}
}

interface JsonOpts {
	/** Nur im Browser wirksam - siehe `encryptsHere`. */
	encrypted?: boolean;
}

async function readJson<T>(file: string, fallback: T, opts: JsonOpts = {}): Promise<T> {
	const path = `${DIR}/${file}`;
	if (!(await storage.exists(path))) return fallback;
	try {
		const txt = await storage.readTextFile(path);
		if (!txt.trim()) return fallback;
		return opts.encrypted ? await decryptFromStorage<T>(file, txt) : (JSON.parse(txt) as T);
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

function writeJson(file: string, data: unknown, opts: JsonOpts = {}): Promise<void> {
	return queued(file, () => writeJsonNow(file, data, opts));
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
	/** `after === null` heisst: der Report dieses Monats faellt weg. */
	timeReport(
		month: string,
		before: StoredTimeReport | null,
		after: StoredTimeReport | null
	): Promise<StoredTimeReport | null>;
}

let writeHook: WriteHook | null = null;

export function setWriteHook(hook: WriteHook | null): void {
	writeHook = hook;
}

async function writeJsonNow(file: string, data: unknown, opts: JsonOpts = {}): Promise<void> {
	await ensureDir();
	const target = `${DIR}/${file}`;
	const json = opts.encrypted ? await encryptForStorage(file, data) : JSON.stringify(data, null, 2);
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
	return readJson<Activity[]>("activities.json", [], { encrypted: true });
}
export async function saveActivities(activities: Activity[]): Promise<void> {
	if (!writeHook) return writeJson("activities.json", activities, { encrypted: true });
	return queued("activities.json", async () => {
		const before = await readJson<Activity[]>("activities.json", [], { encrypted: true });
		await writeJsonNow("activities.json", await writeHook!.activities(before, activities), {
			encrypted: true
		});
	});
}

// ---- Einstellungen ----
/** Ob bereits eine settings.json existiert (false = erster Programmstart). */
export async function settingsFileExists(): Promise<boolean> {
	return storage.exists(`${DIR}/settings.json`);
}
export async function loadSettings(): Promise<Settings> {
	const stored = await readJson<Partial<Settings>>("settings.json", {}, { encrypted: true });
	return { ...defaultSettings, ...stored };
}
export async function saveSettings(settings: Settings): Promise<void> {
	if (!writeHook) return writeJson("settings.json", settings, { encrypted: true });
	return queued("settings.json", async () => {
		const before = await readJson<Settings | null>("settings.json", null, { encrypted: true });
		await writeJsonNow("settings.json", await writeHook!.settings(before, settings), {
			encrypted: true
		});
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
		return await decryptFromStorage<Entry[]>(file, txt);
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
	if (!writeHook) return writeJson(file, entries, { encrypted: true });
	return queued(file, async () => {
		const before = await readEntriesRaw(month);
		await writeJsonNow(file, await writeHook!.entries(month, before, entries), {
			encrypted: true
		});
	});
}

/** Der Stand einer Monatsdatei ohne die Quarantaene-Behandlung von `loadEntries`. */
async function readEntriesRaw(month: string): Promise<Entry[]> {
	return readJson<Entry[]>(entriesFile(month), [], { encrypted: true });
}

/** Alle Monats-Keys mit Eintraegen, neueste zuerst. */
export async function listEntryMonths(): Promise<string[]> {
	return (await dataFiles(MONTH_FILE_RE)).map(([, month]) => month).sort().reverse();
}

/**
 * Bis hierhin kann eine Monatsdatei leer sein ("[]"); ein Eintrag braucht ueber
 * 150 Zeichen. Im Browser ist eine leere Datei verschluesselt etwas groesser
 * als das rohe "[]" (JWE-Huelle mit IV und Pruefsumme) - der Rahmen ist grosszuegig.
 */
const EMPTY_MONTH_MAX_BYTES = 200;

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
export interface StoredTimeReport extends SyncMeta {
	/** "YYYY-MM" */
	month: string;
	/** Wann die Datei eingelesen wurde (Epoch-ms) */
	importedAt: number;
	/**
	 * Nur die Tage DIESES Monats, aufsteigend.
	 *
	 * Bewusst ohne Personalnummer und Namen: gerechnet wird damit nirgends, und
	 * was nicht abgelegt wird, kann auch nicht in eine Sicherung oder auf einen
	 * Server wandern. Wem der Report gehoert, steht in den Einstellungen unter
	 * "Bericht & E-Mail" - beim Einlesen wird dagegen geprueft.
	 */
	days: TimeReportDay[];
}

function reportFile(month: string): string {
	return `timereport-${month}.json`;
}

/** Die Flag-Namen vor 0.9.2. Zum Lesen alter Reports, nicht zum Schreiben. */
const LEGACY_FLAG_KEYS: Record<string, TimeReportFlag["key"]> = {
	ruhepause: "restBreak",
	ueber10: "over10",
	soll10: "target10",
	wiedereingliederung: "gradualReturn",
	sonntag: "sunday",
	feiertag: "holiday"
};

/** Den gespeicherten Report eines Monats lesen. Null, wenn keiner vorliegt. */
export async function loadTimeReport(month: string): Promise<StoredTimeReport | null> {
	const stored = await readJson<StoredTimeReport | null>(reportFile(month), null, {
		encrypted: true
	});
	// Eine Datei aus einer aelteren/kaputten Fassung soll die Ansicht nicht kippen.
	if (!stored || !Array.isArray(stored.days)) return null;

	// Ausdruecklich Feld fuer Feld statt `...stored`: aeltere Dateien tragen noch
	// Personalnummer und Namen. Ueber den Spread landeten sie beim naechsten
	// Speichern wieder auf der Platte - und spaeter im Abgleich.
	//
	// Die Flag-Namen von vor der Umbenennung werden dabei uebersetzt; ohne das
	// faellt jeder Hinweis stumm aus der Ansicht.
	return {
		month: stored.month,
		importedAt: stored.importedAt,
		// Die Stempel gehoeren mitgenommen: ohne sie hielte der Abgleich jeden
		// gespeicherten Report fuer nie hochgeladen und schriebe ihn endlos neu.
		updatedAt: stored.updatedAt,
		rev: stored.rev,
		deviceId: stored.deviceId,
		days: stored.days.map((day) => ({
			...day,
			flags: (day.flags ?? []).map((flag) => ({
				...flag,
				key: LEGACY_FLAG_KEYS[flag.key] ?? flag.key
			}))
		}))
	};
}

export async function saveTimeReport(report: StoredTimeReport): Promise<void> {
	const file = reportFile(report.month);
	if (!writeHook) return writeJson(file, report, { encrypted: true });
	return queued(file, async () => {
		const before = await loadTimeReportRaw(report.month);
		const stamped = await writeHook!.timeReport(report.month, before, report);
		await writeJsonNow(file, stamped ?? report, { encrypted: true });
	});
}

/**
 * Den Report eines Monats entfernen.
 *
 * Geht durch den Haken, damit die Loeschung auch auf den anderen Geraeten
 * ankommt - eine bloss geloeschte Datei bliebe dort stehen.
 */
export async function deleteTimeReport(month: string): Promise<void> {
	const file = reportFile(month);
	return queued(file, async () => {
		if (writeHook) await writeHook.timeReport(month, await loadTimeReportRaw(month), null);
		const path = `${DIR}/${file}`;
		if (await storage.exists(path)) await storage.remove(path);
	});
}

/** Der Stand einer Reportdatei, wie er auf der Platte liegt. */
async function loadTimeReportRaw(month: string): Promise<StoredTimeReport | null> {
	return readJson<StoredTimeReport | null>(reportFile(month), null, { encrypted: true });
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
	/**
	 * Welchen Nachlauf dieses Geraet schon hinter sich hat.
	 *
	 * Der Stand `seq` wandert weiter, auch ueber Datensatzarten, die diese Fassung
	 * noch nicht kannte - die sind damit fuer immer uebersprungen. Kommt eine Art
	 * hinzu, wird die Zahl hier hochgesetzt; jedes Geraet holt dann einmalig von
	 * vorne. Siehe RESYNC_GENERATION.
	 */
	resyncGeneration?: number;
	/** Anzeigename des Kontos - nur fuer die Oberflaeche. */
	accountName?: string;
	/**
	 * Der Passkey, mit dem dieser Browser zuletzt hereingekommen ist.
	 *
	 * Ein Konto kann mehrere haben; von der Kontoliste aus ist nicht zu sehen,
	 * welcher an DIESEM Browser haengt. Ohne diese Kennung waere nicht zu
	 * beurteilen, ob der hiesige Passkey die Daten allein oeffnen kann.
	 */
	passkeyId?: string;
	/**
	 * Zu welchem Konto der hier liegende Schluessel gehoert.
	 *
	 * Laeuft die Sitzung im Browser ab, bleibt der Schluessel liegen. Meldet sich
	 * danach jemand mit einem Passkey an, entscheidet dieser Vergleich, ob es
	 * dasselbe Konto ist - und ob der Schluessel damit weiterbenutzt werden darf.
	 * Ohne den Vergleich bekaeme ein fremdes Konto den Schluessel des vorigen.
	 */
	accountUserId?: string;
	/**
	 * Welches Konto hier haengt - der Nachweis aus seinem Tresorschluessel.
	 *
	 * Zwei Konten haben verschiedene Schluessel, also verschiedene Nachweise.
	 * Damit laesst sich ein Kontowechsel erkennen, ohne die Kontokennung selbst
	 * abzulegen.
	 */
	accountFingerprint?: string;
	/**
	 * Wem der lokale Bestand gehoert.
	 *
	 * Weicht das von `accountFingerprint` ab, stammen die Daten aus einem ANDEREN
	 * Konto - dann duerfen sie nicht in das jetzige hochgeladen werden. Fehlt der
	 * Wert, hat dieses Geraet noch nie ein Konto gesehen: der Bestand ist dann
	 * der eigene und gehoert hoch.
	 */
	dataOwner?: string;
	/**
	 * Ob der einmalige Nachhol-Durchlauf schon lief, der bestehende Dateien im
	 * Browser verschluesselt (siehe `app.svelte.ts`). Ohne den Merker liefe er
	 * bei jedem Start erneut - fuer nichts, sobald einmal alles verschluesselt ist.
	 */
	localFilesEncrypted?: boolean;
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
	await ensureDir();
	// Der ganze Datenordner, keine gepflegte Namensliste: liegengebliebene
	// .tmp-Dateien und in Quarantaene gelegte Monate (.beschaedigt-*) tragen
	// denselben Bestand, standen aber in keiner Liste.
	for (const { name } of await storage.readDir(DIR)) {
		// Die Geraetekennung gehoert dem Rechner, nicht dem Konto - sie soll ein
		// erneutes Koppeln wiedererkennen. Die Kontodaten daneben streift das
		// Abmelden ab.
		if (name === "device.json") continue;
		// Durch dieselbe Warteschlange wie das Schreiben: ein bereits eingereihtes
		// Speichern landete sonst NACH dem Loeschen - und der Bestand waere zurueck.
		await queued(name, async () => {
			const path = `${DIR}/${name}`;
			if (await storage.exists(path)) await storage.remove(path);
		});
	}
}

/**
 * Die Merkliste leeren - was darin steht, gehoert dem vorigen Konto.
 *
 * Getrennt von `clearAccountData`, weil sie auch dort weg muss, wo die Zeiten
 * bleiben sollen: der Abgleich liest die Outbox und fragt dabei keinen Stempel.
 */
export async function clearOutbox(): Promise<void> {
	const path = `${DIR}/outbox.json`;
	if (await storage.exists(path)) await storage.remove(path);
}

/** Die Feldnamen vor 0.9.2. Zum Lesen alter Dateien, nicht zum Schreiben. */
interface LegacyDeviceInfo {
	kontoKennung?: string;
	bestandGehoertZu?: string;
}

export async function loadDevice(): Promise<DeviceInfo | null> {
	const info = await readJson<(DeviceInfo & LegacyDeviceInfo) | null>("device.json", null);
	if (!info) return null;

	// Geraete aus aelteren Fassungen tragen die alten Feldnamen. Wuerden sie hier
	// verworfen, saehe der naechste Abgleich ein Geraet ohne Kontozuordnung -
	// und genau das loest das Loeschen des lokalen Bestands aus.
	const { kontoKennung, bestandGehoertZu, ...rest } = info;
	return {
		...rest,
		accountFingerprint: info.accountFingerprint ?? kontoKennung,
		dataOwner: info.dataOwner ?? bestandGehoertZu
	};
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
	const ofYear = async (re: RegExp) =>
		(await dataFiles(re)).filter(([, month]) => month.startsWith(`${year}-`));

	// Die Monate gehen ueber saveEntries(month, []) und NICHT ueber ein direktes
	// storage.remove(): nur so laeuft die Loeschung durch den Haken und landet in
	// der Outbox - sonst faende der naechste Abgleich die Monate beim Server
	// unveraendert vor und laedt das geloeschte Jahr wieder herunter.
	const months = (await ofYear(MONTH_FILE_RE)).map(([, month]) => month);
	for (const month of months) await saveEntries(month, []);

	// Die eingelesenen Reports aus demselben Grund ueber deleteTimeReport und nicht
	// ueber ein direktes storage.remove(): auch sie werden abgeglichen, seit es sie
	// als eigene Datensatzart gibt. Direkt geloescht kaemen sie beim naechsten
	// Abgleich vom Server zurueck.
	for (const [, month] of await ofYear(REPORT_FILE_RE)) await deleteTimeReport(month);
	return months.sort();
}
