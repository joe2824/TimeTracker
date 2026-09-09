// Datei-basierte Persistenz über tauri-plugin-fs.
// Alle Daten liegen als JSON im App-Daten-Ordner unter "data/":
//   data/activities.json          (global)
//   data/settings.json            (global)
//   data/entries-YYYY-MM.json     (eine Datei pro Monat)
//   data/timereport-YYYY-MM.json  (eingelesener LOGA-Report, eine Datei pro Monat)
import { storage, usingBrowserStorage } from "./platform/fs";
import type { Activity, Entry, Settings, SyncMeta } from "./types";
import type { TimeReportDay, TimeReportFlag } from "./report/timeReport";
import type { SyncPriority } from "./sync/engine";
import { defaultSettings } from "./types";
import { logError, logWarn } from "./log";
import {
	fromBase64,
	importVaultKey,
	openRecord,
	sealRecord,
	type VaultKey
} from "./crypto/vault";
import {
	discardLegacyVaultKey,
	hasLegacyVaultKey,
	loadLocalVaultKey,
	saveLocalVaultKey
} from "./platform/keyStore";
import { unprotectSecret } from "./platform/secrets";

const DIR = "data";

async function ensureDir(): Promise<void> {
	if (!(await storage.exists(DIR))) await storage.mkdir(DIR);
}

// ---- Verschlüsselung der lokalen Ablage (nur Browser) ----
//
// Auf dem Rechner schützt das Betriebssystem den App-Datenordner bereits.
// Im Browser liegt IndexedDB offen - für jede Erweiterung mit Speicherzugriff
// oder jeden zweiten Blick ins Profil. Verschlüsselt wird mit demselben
// AES-GCM/JWE, das auch für den Server-Abgleich läuft (sealRecord/
// openRecord, crypto/vault.ts) - hier mit `kind:"local"` gebunden an den
// Dateinamen, damit eine vertauschte Datei nicht unbemerkt durchgeht.
//
// `device.json` und `outbox.json` bleiben aussen vor (kein `encrypted`-Aufruf
// an ihren Lese-/Schreibstellen): `device.json` enthält den Schlüssel selbst
// - zirkulär -, `outbox.json` nur Referenzen, keine Inhalte.
let localKey: VaultKey | null = null;

/** Den Schlüssel setzen, mit dem die Browser-Ablage ver-/entschlüsselt wird. */
export function setLocalEncryptionKey(key: VaultKey | null): void {
	localKey = key;
}

/**
 * Der schon geladene Schlüssel, falls einer vorliegt - ohne erneuten
 * IndexedDB-Zugriff. `account.svelte.ts` greift beim Wiedereinstieg darauf
 * zurück, statt den Schlüssel ein zweites Mal zu holen (siehe
 * `preloadLocalEncryptionKey`, läuft vorher in `app.init()`).
 */
export function getLocalEncryptionKey(): VaultKey | null {
	return localKey;
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
 * Kein Schlüssel vorhanden - anders als eine wirklich beschädigte Datei:
 * die Datei ist vermutlich in Ordnung, nur (noch) nicht zu öffnen. Aufrufer
 * unterscheiden danach, ob sie eine Datei in Quarantäne legen dürfen.
 */
class LocalKeyUnavailableError extends Error {}

/**
 * Alte Dateien liegen noch als Klartext da - kein Fehler, sondern der Stand
 * vor dieser Änderung. Sie werden beim nächsten Speichern verschlüsselt
 * (siehe `app.svelte.ts`s einmaligem Nachhol-Durchlauf); bis dahin bleiben
 * sie lesbar.
 */
async function decryptFromStorage<T>(file: string, txt: string): Promise<T> {
	if (!looksEncrypted(txt)) return JSON.parse(txt) as T;
	if (!localKey) throw new LocalKeyUnavailableError(`${file}: kein Schlüssel geladen`);
	return openRecord<T>(localKey, txt, { kind: "local", id: file, rev: 0 });
}

/**
 * Der Schlüssel, wie ihn die `device.json` auf dem Rechner führt: base64,
 * dazu vom Betriebssystem geschützt. Im Browser gibt es ihn dort nicht - dort
 * liegt er in `platform/keyStore.ts`.
 */
export async function readProtectedVaultKey(
	info: DeviceInfo,
	extractable: boolean
): Promise<VaultKey | null> {
	if (!info.vaultKey) return null;
	const raw = await unprotectSecret(info.vaultKey, info.protected ?? false);
	return importVaultKey(fromBase64(raw).buffer as ArrayBuffer, extractable);
}

/**
 * Beim Start: den Vault-Schlüssel vorladen, damit verschlüsselte Dateien
 * gleich beim ersten Lesen aufgehen - unabhängig vom Konto-Abgleich, der erst
 * danach anläuft und das Netz braucht (`app.init()` läuft vor `account.init()`).
 * Nur im Browser: auf dem Rechner schützt das Betriebssystem den Datenordner.
 *
 * Ein Schlüssel, der noch als lesbare Bytes in `device.json` liegt, wird dabei
 * einmalig in die neue Ablage übernommen - sonst hängt ein solcher Browser
 * fest, bis jemand die Website-Daten von Hand löscht.
 *
 * Ist das Gerät verknüpft (`serverUrl` gesetzt), lässt sich aber kein
 * Schlüssel herstellen, wird geworfen statt still weiterzumachen: die
 * nächsten Lesevorgänge sähen sonst leere Dateien statt der echten
 * verschlüsselten Daten, und ein Speichern kurz danach schriebe diese leere
 * Sicht darüber. `app.init()` zeigt den Fehler wie jeden anderen Startfehler.
 */
export async function preloadLocalEncryptionKey(): Promise<void> {
	if (!usingBrowserStorage()) return;
	const existing = await loadLocalVaultKey().catch(() => null);
	if (existing) {
		setLocalEncryptionKey(existing);
		await discardLegacyVaultKey().catch(() => {});
		return;
	}
	const info = await loadDevice();
	if (info) {
		try {
			const migrated = await readProtectedVaultKey(info, false);
			if (migrated) {
				await saveLocalVaultKey(migrated);
				setLocalEncryptionKey(migrated);
				await discardLegacyVaultKey();
				return;
			}
		} catch (e) {
			logWarn("Alter Vault-Schlüssel ließ sich nicht übernehmen", e);
		}
	}
	if (info?.serverUrl) {
		// Ein Schlüssel in der alten Ablage ist nicht mehr zu gebrauchen (siehe
		// platform/keyStore.ts). Eigener Hinweis, weil "bitte neu laden" hier nie hilft.
		if (await hasLegacyVaultKey().catch(() => false)) {
			throw new Error(
				"Diese Version legt den Schlüssel für deine Daten anders ab - der auf diesem Gerät gespeicherte passt nicht mehr dazu. Setze die Anmeldung zurück und melde dich neu an; deine Zeiten kommen danach wieder vom Server."
			);
		}
		throw new Error(
			"Der Schlüssel für deine Daten ließ sich nicht öffnen. Bitte die Seite neu laden - hilft das nicht, einmal neu anmelden."
		);
	}
}

interface JsonOpts {
	/** Nur im Browser wirksam - siehe `encryptsHere`. */
	encrypted?: boolean;
}

/**
 * Eine Datei, die sich mit vorliegendem Schlüssel nicht öffnen lässt, aus dem
 * Weg legen statt sie überschreiben zu lassen.
 *
 * Umbenennen, nicht löschen - der neue Name passt auf keines der Muster
 * (MONTH_FILE_RE, REPORT_FILE_RE), die Datei wird also weder gelistet noch
 * aufgeräumt und bleibt für eine Rettung von Hand liegen.
 */
async function quarantine(file: string, e: unknown): Promise<void> {
	const path = `${DIR}/${file}`;
	const target = `${path}.beschaedigt-${Date.now()}`;
	logError(`${file} ist beschädigt, abgelegt als ${target}`, e);
	try {
		await storage.rename(path, target);
	} catch (renameErr) {
		logError("Beschädigte Datei konnte nicht abgelegt werden", renameErr);
	}
}

/**
 * Eine Datei lesen. Drei Ausgänge, und der Unterschied zählt:
 *
 * - kein Schlüssel: die Datei ist vermutlich in Ordnung, nur (noch) nicht zu
 *   öffnen. Sie bleibt unangetastet liegen und wird beim nächsten Lesen mit
 *   vorliegendem Schlüssel wieder versucht.
 * - beschaedigt (oder mit vorliegendem Schlüssel nicht zu entschlüsseln): in
 *   Quarantäne. Ohne das gäbe der Ersatzwert eine leere Sicht vor, und der
 *   nächste Speichervorgang schriebe sie über die intakte Datei - beim
 *   Abgleich bis auf die anderen Geräte. Gilt auch für die Klartextdateien
 *   (`device.json`, `outbox.json`).
 * - sonst: der Inhalt.
 */
async function readJson<T>(file: string, fallback: T, opts: JsonOpts = {}): Promise<T> {
	const path = `${DIR}/${file}`;
	if (!(await storage.exists(path))) return fallback;
	let txt: string;
	try {
		txt = await storage.readTextFile(path);
	} catch (e) {
		logWarn(`${file} konnte nicht gelesen werden`, e);
		return fallback;
	}
	if (!txt.trim()) return fallback;
	try {
		return opts.encrypted ? await decryptFromStorage<T>(file, txt) : (JSON.parse(txt) as T);
	} catch (e) {
		if (e instanceof LocalKeyUnavailableError) {
			logWarn(`${file} konnte nicht gelesen werden`, e);
			return fallback;
		}
		await quarantine(file, e);
		return fallback;
	}
}

/**
 * Je Datei ein Schreibvorgang zur Zeit; das jeweils letzte Versprechen hält die
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
	// Ein gescheiterter Vorgänger darf den nächsten nicht mitreissen: dessen
	// Aufrufer hat seinen Fehler schon bekommen.
	const next = prev.then(op, op);
	writeQueue.set(file, next);
	void next.catch(() => {}).then(() => {
		// Nur wegräumen, wenn seitdem nichts Neues angehängt wurde.
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
 * Läuft INNERHALB der Warteschlange: damit sieht er jede Änderung genau einmal
 * und in der richtigen Reihenfolge.
 */
export interface WriteHook {
	entries(month: string, before: Entry[], after: Entry[]): Promise<Entry[]>;
	activities(before: Activity[], after: Activity[]): Promise<Activity[]>;
	settings(before: Settings | null, after: Settings): Promise<Settings>;
	/** `after === null` heisst: der Report dieses Monats fällt weg. */
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
		// Die temp-Datei liegt sonst für immer im Datenordner – und zwar bei
		// JEDEM Speichern erneut, solange rename scheitert.
		try {
			if (await storage.exists(tmp)) await storage.remove(tmp);
		} catch {
			/* Aufräumen darf das Speichern nicht kippen */
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

// ---- Aktivitäten ----
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

// ---- Einträge (pro Monat) ----
/**
 * Einträge eines Monats lesen.
 *
 * Eine beschädigte Datei darf NICHT als "leer" durchgehen: pruneEmptyMonthFiles
 * und der nächste Speichervorgang hätten sie sonst gelöscht. Darum kümmert
 * sich `readJson` (Quarantäne).
 */
export async function loadEntries(month: string): Promise<Entry[]> {
	return readJson<Entry[]>(entriesFile(month), [], { encrypted: true });
}
export async function saveEntries(month: string, entries: Entry[]): Promise<void> {
	// Ein leerer Monat hinterlässt keine Datei: sonst bliebe eine "[]"-Datei liegen
	// und der Monat geisterte ohne Einträge weiter durch die Monatsauswahl.
	const file = entriesFile(month);
	if (entries.length === 0) {
		return queued(file, async () => {
			const path = `${DIR}/${file}`;
			// Auch das Leeren geht durch den Haken: sonst verschwände ein
			// geleerter Monat, ohne dass der Abgleich die Löschungen je erfährt.
			if (writeHook) await writeHook.entries(month, await loadEntries(month), []);
			if (await storage.exists(path)) await storage.remove(path);
		});
	}
	if (!writeHook) return writeJson(file, entries, { encrypted: true });
	return queued(file, async () => {
		const before = await loadEntries(month);
		await writeJsonNow(file, await writeHook!.entries(month, before, entries), {
			encrypted: true
		});
	});
}

/** Alle Monats-Keys mit Einträgen, neueste zuerst. */
export async function listEntryMonths(): Promise<string[]> {
	return (await dataFiles(MONTH_FILE_RE)).map(([, month]) => month).sort().reverse();
}

/**
 * Bis hierhin kann eine Monatsdatei leer sein ("[]"); ein Eintrag braucht über
 * 150 Zeichen. Im Browser ist eine leere Datei verschlüsselt etwas grösser
 * als das rohe "[]" (JWE-Hülle mit IV und Prüfsumme) - der Rahmen ist grosszügig.
 */
const EMPTY_MONTH_MAX_BYTES = 200;

/**
 * Beim Start: leere "[]"-Monatsdateien entfernen, die frühere Versionen liegen
 * liessen. Ohne das geisterten die Monate ohne Einträge durch die Auswahl.
 */
export async function pruneEmptyMonthFiles(): Promise<string[]> {
	const pruned: string[] = [];
	for (const [name, month] of await dataFiles(MONTH_FILE_RE)) {
		// Metadaten statt Inhalt. Antwortet das Dateisystem nicht, bleibt die Datei
		// liegen – gelöscht wird nur, was nachweislich leer ist.
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
	 * Server wandern. Wem der Report gehört, steht in den Einstellungen unter
	 * "Bericht & E-Mail" - beim Einlesen wird dagegen geprüft.
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
	// Eine Datei aus einer älteren/kaputten Fassung soll die Ansicht nicht kippen.
	if (!stored || !Array.isArray(stored.days)) return null;

	// Ausdrücklich Feld für Feld statt `...stored`: ältere Dateien tragen noch
	// Personalnummer und Namen. Über den Spread landeten sie beim nächsten
	// Speichern wieder auf der Platte - und später im Abgleich.
	//
	// Die Flag-Namen von vor der Umbenennung werden dabei übersetzt; ohne das
	// fällt jeder Hinweis stumm aus der Ansicht.
	return {
		month: stored.month,
		importedAt: stored.importedAt,
		// Die Stempel gehören mitgenommen: ohne sie hielte der Abgleich jeden
		// gespeicherten Report für nie hochgeladen und schriebe ihn endlos neu.
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
 * Geht durch den Haken, damit die Löschung auch auf den anderen Geräten
 * ankommt - eine bloss gelöschte Datei bliebe dort stehen.
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

// ---- Gerät und Abgleich ----

/**
 * Was dieses Gerät über sich und seine Verknüpfung weiss.
 *
 * Eigene Datei, bewusst NICHT settings.json: Token und Vault-Schlüssel gehören
 * nicht in etwas, das in jedem Backup und jedem Fehlerbericht landet.
 */
export interface DeviceInfo {
	/** Zufällige, dauerhafte Kennung dieses Geräts. */
	id: string;
	/** Adresse des Servers, z.B. "https://tracker.example.de". */
	serverUrl?: string;
	/** Das Geräte-Token, geschützt über das Betriebssystem (siehe secret.rs). */
	token?: string;
	/** Der Vault-Schlüssel, ebenso geschützt. */
	vaultKey?: string;
	/** Ob Token und Schlüssel wirklich vom Betriebssystem geschützt sind. */
	protected?: boolean;
	/** Bis zu welchem Serverstand dieses Gerät alles kennt. */
	seq?: number;
	/** Der vorgezogene Teil des Abgleichs - nur da, solange Historie fehlt. */
	priority?: SyncPriority;
	/**
	 * Welchen Nachlauf dieses Gerät schon hinter sich hat.
	 *
	 * Der Stand `seq` wandert weiter, auch über Datensatzarten, die diese Fassung
	 * noch nicht kannte - die sind damit für immer übersprungen. Kommt eine Art
	 * hinzu, wird die Zahl hier hochgesetzt; jedes Gerät holt dann einmalig von
	 * vorne. Siehe RESYNC_GENERATION.
	 */
	resyncGeneration?: number;
	/** Anzeigename des Kontos - nur für die Oberfläche. */
	accountName?: string;
	/**
	 * Der Passkey, mit dem dieser Browser zuletzt hereingekommen ist.
	 *
	 * Ein Konto kann mehrere haben; von der Kontoliste aus ist nicht zu sehen,
	 * welcher an DIESEM Browser hängt. Ohne diese Kennung wäre nicht zu
	 * beurteilen, ob der hiesige Passkey die Daten allein öffnen kann.
	 */
	passkeyId?: string;
	/**
	 * Zu welchem Konto der hier liegende Schlüssel gehört.
	 *
	 * Läuft die Sitzung im Browser ab, bleibt der Schlüssel liegen. Meldet sich
	 * danach jemand mit einem Passkey an, entscheidet dieser Vergleich, ob es
	 * dasselbe Konto ist - und ob der Schlüssel damit weiterbenutzt werden darf.
	 * Ohne den Vergleich bekäme ein fremdes Konto den Schlüssel des vorigen.
	 */
	accountUserId?: string;
	/**
	 * Welches Konto hier hängt - der Nachweis aus seinem Vault-Schlüssel.
	 *
	 * Zwei Konten haben verschiedene Schlüssel, also verschiedene Nachweise.
	 * Damit lässt sich ein Kontowechsel erkennen, ohne die Kontokennung selbst
	 * abzulegen.
	 */
	accountFingerprint?: string;
	/**
	 * Wem der lokale Bestand gehört.
	 *
	 * Weicht das von `accountFingerprint` ab, stammen die Daten aus einem ANDEREN
	 * Konto - dann dürfen sie nicht in das jetzige hochgeladen werden. Fehlt der
	 * Wert, hat dieses Gerät noch nie ein Konto gesehen: der Bestand ist dann
	 * der eigene und gehört hoch.
	 */
	dataOwner?: string;
	/**
	 * Ob der einmalige Nachhol-Durchlauf schon lief, der bestehende Dateien im
	 * Browser verschlüsselt (siehe `app.svelte.ts`). Ohne den Merker liefe er
	 * bei jedem Start erneut - für nichts, sobald einmal alles verschlüsselt ist.
	 */
	localFilesEncrypted?: boolean;
}

/**
 * Alles löschen, was zu einem Konto gehört – Einträge, Aktivitäten, Outbox,
 * Einstellungen und eingelesene Reports.
 *
 * Für den Browser und bei Kontowechsel: dort ist der lokale Bestand nur die
 * Kopie eines Kontos. Bleiben Daten liegen, sieht der nächste Mensch die Zeiten
 * und Einstellungen des vorigen – und schlimmer: sie wandern beim nächsten
 * Abgleich in SEIN Konto.
 */
export async function clearAccountData(): Promise<void> {
	await ensureDir();
	// Der ganze Datenordner, keine gepflegte Namensliste: liegengebliebene
	// .tmp-Dateien und in Quarantäne gelegte Monate (.beschaedigt-*) tragen
	// denselben Bestand, standen aber in keiner Liste.
	for (const { name } of await storage.readDir(DIR)) {
		// Die Gerätekennung gehört dem Rechner, nicht dem Konto - sie soll ein
		// erneutes Koppeln wiedererkennen. Die Kontodaten daneben streift das
		// Abmelden ab.
		if (name === "device.json") continue;
		// Durch dieselbe Warteschlange wie das Schreiben: ein bereits eingereihtes
		// Speichern landete sonst NACH dem Löschen - und der Bestand wäre zurück.
		await queued(name, async () => {
			const path = `${DIR}/${name}`;
			if (await storage.exists(path)) await storage.remove(path);
		});
	}
}

/**
 * Die Merkliste leeren - was darin steht, gehört dem vorigen Konto.
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

	// Geräte aus älteren Fassungen tragen die alten Feldnamen. Würden sie hier
	// verworfen, sähe der nächste Abgleich ein Gerät ohne Kontozuordnung -
	// und genau das löst das Löschen des lokalen Bestands aus.
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

/**
 * `device.json` lesen, ändern und schreiben, ohne dass dazwischen jemand
 * anders schreibt.
 *
 * Mehrere Stellen schreiben je ihr eigenes Feld fort: der Abgleich seinen Stand,
 * die Anmeldung den Passkey, der Nachhol-Durchlauf seinen Merker. Zwei
 * überlappende Lese-Ändern-Schreib-Folgen verlieren dabei den Stand der
 * jeweils anderen - geht der Abgleichstand verloren, holt das Gerät die
 * Datensätze ein zweites Mal, und die Sperren für Sicherung und Monatsauswahl
 * gehen wieder auf.
 *
 * `patch` bekommt den frisch gelesenen Stand und gibt den neuen zurück; `null`
 * heisst "nichts schreiben". Innerhalb von `patch` NICHT `saveDevice` oder
 * `updateDevice` aufrufen - beide warten dann auf diesen Aufruf.
 */
export function updateDevice(
	patch: (info: DeviceInfo | null) => DeviceInfo | null | Promise<DeviceInfo | null>
): Promise<void> {
	return queued("device.json", async () => {
		const next = await patch(await loadDevice());
		if (next) await writeJsonNow("device.json", next);
	});
}

/**
 * Was dieses Gerät über seine Team-Mitgliedschaft weiss.
 *
 * Eigene Datei, nicht `device.json`: ein Team-Mitglied hat kein Konto und
 * keinen Vault-Schlüssel - beides bleibt hier komplett aussen vor. Wie
 * `device.json` bewusst NICHT verschlüsselt (siehe oben): das Token ist
 * selbst schon der Zugang, kein Inhalt, der einen Schlüssel bräuchte.
 */
export interface TeamDeviceInfo {
	teamMemberId: string;
	/** Das Team-Token - siehe server/src/lib/server/teams.ts. */
	token: string;
	teamName: string;
	serverUrl: string;
}

export async function loadTeamDevice(): Promise<TeamDeviceInfo | null> {
	return readJson<TeamDeviceInfo | null>("team.json", null);
}

export async function saveTeamDevice(info: TeamDeviceInfo): Promise<void> {
	return writeJson("team.json", info);
}

/** Die Team-Mitgliedschaft aufgeben - z.B. nach dem Hinauswerfen durch den Chef. */
export async function clearTeamDevice(): Promise<void> {
	const path = `${DIR}/team.json`;
	if (await storage.exists(path)) await storage.remove(path);
}

/** Ausstehende Änderungen. Der Inhalt steht in sync/outbox.ts. */
export async function loadOutbox<T>(): Promise<T[]> {
	const stored = await readJson<T[]>("outbox.json", []);
	return Array.isArray(stored) ? stored : [];
}

export async function saveOutbox<T>(changes: T[]): Promise<void> {
	return writeJson("outbox.json", changes);
}

export interface StoredYear {
	year: number;
	/** Monate mit Einträgen in diesem Jahr */
	months: number;
	/** Einträge insgesamt – damit vor dem Löschen sichtbar ist, was weg wäre */
	entries: number;
}

/** Jahre mit Einträgen, neueste zuerst, inkl. Umfang für die Lösch-Abfrage. */
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

/** Alle Monatsdateien eines Jahres löschen. Gibt die gelöschten Monate zurück. */
export async function deleteYear(year: number): Promise<string[]> {
	const ofYear = async (re: RegExp) =>
		(await dataFiles(re)).filter(([, month]) => month.startsWith(`${year}-`));

	// Die Monate gehen über saveEntries(month, []) und NICHT über ein direktes
	// storage.remove(): nur so läuft die Löschung durch den Haken und landet in
	// der Outbox - sonst fände der nächste Abgleich die Monate beim Server
	// unverändert vor und lädt das gelöschte Jahr wieder herunter.
	const months = (await ofYear(MONTH_FILE_RE)).map(([, month]) => month);
	for (const month of months) await saveEntries(month, []);

	// Die eingelesenen Reports aus demselben Grund über deleteTimeReport und nicht
	// über ein direktes storage.remove(): auch sie werden abgeglichen, seit es sie
	// als eigene Datensatzart gibt. Direkt gelöscht kämen sie beim nächsten
	// Abgleich vom Server zurück.
	for (const [, month] of await ofYear(REPORT_FILE_RE)) await deleteTimeReport(month);
	return months.sort();
}
