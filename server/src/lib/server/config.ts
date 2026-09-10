// Die Betriebseinstellungen, alle aus der Umgebung.

function required(name: string, fallback?: string): string {
	const v = process.env[name] ?? fallback;
	if (!v) throw new Error(`Umgebungsvariable ${name} fehlt`);
	return v;
}

/**
 * Die Adresse, unter der die Anwendung erreichbar ist, z.B.
 * "https://tracker.example.de". Muss exakt stimmen: WebAuthn prüft sie.
 */
export const ORIGIN = required("ORIGIN", "http://localhost:5173");

/**
 * Die Kennung, an die Passkeys gebunden sind - der Hostname ohne Schema und
 * Port.
 */
export const RP_ID = required("RP_ID", new URL(ORIGIN).hostname);

/** Der Name, den der Anmeldedialog des Betriebssystems anzeigt. */
export const RP_NAME = process.env.RP_NAME ?? "TimeTracker";

/** Herkünfte, von denen schreibende Anfragen angenommen werden. */
export const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS ?? "")
	.split(",")
	.map((o) => o.trim().replace(/\/+$/, ""))
	.filter(Boolean)
	.concat(ORIGIN);

/**
 * Kann diese Kennung überhaupt eine Passkey-Kennung sein?
 *
 * IP-Adressen NICHT - WebAuthn verlangt einen Domainnamen. `localhost` ist die
 * Ausnahme, die auch ohne HTTPS geht; 127.0.0.1 ist für den Browser woanders.
 */
export function isValidRpId(rpId: string): boolean {
	if (rpId === "localhost") return true;
	// IPv4, IPv6 und alles, was keinen Punkt hat, scheidet aus.
	if (/^\d{1,3}(\.\d{1,3}){3}$/.test(rpId)) return false;
	if (rpId.includes(":")) return false;
	return rpId.includes(".");
}

/** Gehört diese Adresse zu unserer Passkey-Kennung - gleiche Domain oder Unterdomain? */
function matchesRpId(origin: string, rpId: string): boolean {
	let host: string;
	try {
		host = new URL(origin).hostname;
	} catch {
		return false;
	}
	return host === rpId || host.endsWith(`.${rpId}`);
}

/** Die Adressen, auf denen Passkeys gelten sollen. */
export const WEBAUTHN_ORIGINS = isValidRpId(RP_ID)
	? ALLOWED_ORIGINS.filter((o) => matchesRpId(o, RP_ID))
	: [];

/** Adressen, die zwar zugreifen dürfen, aber keine Passkeys tragen können. */
export const ORIGINS_WITHOUT_PASSKEY = ALLOWED_ORIGINS.filter((o) => !matchesRpId(o, RP_ID));

export const DATA_DIR = process.env.DATA_DIR ?? "./data";
export const DB_FILE = process.env.DB_FILE ?? `${DATA_DIR}/timetracker.db`;

/** Wo die gebaute PWA liegt - im Image neben dem Server. */
export const CLIENT_DIR = process.env.CLIENT_DIR ?? "static";

/**
 * Die Shell heisst bewusst NICHT index.html: sonst liefert der statische
 * Dateiserver sie unter "/" aus, noch bevor der Rückfall-Handler drankommt -
 * und dann greift weder das Absolutmachen der og:-Adressen noch die CSP aus
 * dem Meta-Tag (siehe hooks.server.ts).
 */
export const APP_SHELL_FILE = "app-shell.html";

/**
 * Konten löschen, an denen sich seither weder ein Gerät gemeldet noch ein
 * Passkey angemeldet hat (Tage, 0 = aus). Wer so lange nicht vorbeischaut,
 * benutzt die Anwendung nicht mehr - die Datenbank soll davon nicht anwachsen.
 * Ein frisch angelegtes, aber nie genutztes Konto zählt erst ab seinem
 * `createdAt` mit, nicht sofort.
 */
export const INACTIVE_ACCOUNT_DAYS = Number(process.env.INACTIVE_ACCOUNT_DAYS ?? 365);
export const INACTIVE_ACCOUNT_MS = INACTIVE_ACCOUNT_DAYS * 24 * 3600_000;

/** Automatische Sicherungen: Intervall in Stunden (0 = aus, Standard 24h). */
export const BACKUP_INTERVAL_HOURS = Number(process.env.BACKUP_INTERVAL_HOURS ?? 24);
/** Wie viele automatische Sicherungen aufgehoben werden (Standard: 7). */
export const BACKUP_KEEP = Number(process.env.BACKUP_KEEP ?? 7);
/** Ordner für Sicherungen. */
export const BACKUP_DIR = process.env.BACKUP_DIR ?? `${DATA_DIR}/backups`;

/** Einladungscodes, durch Komma getrennt. */
export const INVITE_CODES = (process.env.INVITE_CODES ?? "")
	.split(",")
	.map((c) => c.trim())
	.filter(Boolean);

/** Ob sich jeder registrieren darf, der die Adresse kennt. */
export const REGISTRATION_OPEN = /^(1|true|ja|yes)$/i.test(process.env.REGISTRATION_OPEN ?? "");

declare const __SERVER_VERSION__: string;
export const SERVER_VERSION =
	typeof __SERVER_VERSION__ === "string" && __SERVER_VERSION__ !== ""
		? __SERVER_VERSION__
		: (process.env.npm_package_version ?? "0.9.0-beta.7");

/**
 * Geheimer Schlüssel für HMAC-Signaturen von Session-Tokens.
 * Wenn gesetzt: Session-Hashes sind nur mit diesem Schlüssel gültig (sicherer).
 * Wenn nicht gesetzt: Fallback auf einfaches SHA-256 (bisheriges Verhalten).
 * WICHTIG: Denselben Wert in docker-compose.yml / .env setzen und nie ändern -
 * sonst werden alle aktiven Sitzungen beim Neustart ungülig.
 */
export const HMAC_SECRET = process.env.HMAC_SECRET?.trim() || null;

/**
 * Der Ausweis, mit dem eine Tagesmeldung OHNE Anmeldung durchkommt - so zählt
 * eine Installation, die noch gar kein Konto hat.
 *
 * Derselbe Wert wie beim Bauen der Anwendung (`TELEMETRY_KEY`). Nicht gesetzt
 * heisst nicht "Zählung aus": angemeldete Sitzungen und verknüpfte Geräte
 * zählen weiter. Offen ist der Endpunkt trotzdem nie - ein offener Zähler
 * wäre ein Freibrief, DAU und Versionsliste mit Erfundenem zu füllen.
 *
 * Kein echtes Geheimnis: der Schlüssel steckt im ausgelieferten Bundle. Er
 * hält Spam von aussen ab, nicht jemanden, der sich ein Release ansieht.
 */
export const TELEMETRY_KEY = process.env.TELEMETRY_KEY?.trim() || null;

// ---------- Grenzen ----------
//
// Von Anfang an da, nicht nachträglich: ein Konto ohne Obergrenze ist im
// offenen Betrieb eine Einladung, die Platte vollzuschreiben.

/** Grösse eines einzelnen Chiffrats in Byte. Ein Eintrag braucht ~400. */
export const MAX_RECORD_BYTES = 64 * 1024;
/** Datensätze je Konto. Zehn Jahre Erfassung liegen bei ~50.000. */
export const MAX_RECORDS_PER_USER = 500_000;
/** Datensätze in einem einzelnen Schreibvorgang. */
export const MAX_BATCH = 500;
/** Datensätze je Seite beim Abholen. */
export const DEFAULT_PAGE = 500;
export const MAX_PAGE = 2000;
/**
 * Buckets in einem Filter beim Abholen.
 *
 * Die Prio-Menge braucht zwei bis drei; die Grenze hält die IN-Liste unter dem,
 * was SQLite an Platzhaltern annimmt.
 */
export const MAX_BUCKETS = 64;
/** Gleichzeitige Ereignis-Verbindungen je Konto. */
export const MAX_STREAMS_PER_USER = 8;
/** Wie lange die Warteschleife eine Anfrage offen hält. */
export const SYNC_WAIT_MS = Number(process.env.SYNC_WAIT_MS ?? 25_000);

/** Lebensdauer einer Browser-Sitzung - ab der letzten Nutzung, nicht ab der Anmeldung. */
export const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;
/**
 * Ab wann eine benutzte Sitzung verlängert wird.
 *
 * Nicht bei jeder Anfrage: das wäre ein Schreibvorgang je Aufruf, ohne dass
 * sich am Ergebnis etwas ändert.
 */
export const SESSION_REFRESH_MS = 24 * 3600 * 1000;
/** Wie lange eine WebAuthn-Aufgabe gilt. */
export { CHALLENGE_TTL_MS } from "$shared/codes";
/** Wie lange ein Kopplungscode gilt - kurz, er wird abgetippt, nicht verwahrt. */
export const PAIRING_TTL_MS = 10 * 60 * 1000;
