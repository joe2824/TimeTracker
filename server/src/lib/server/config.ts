// Die Betriebseinstellungen, alle aus der Umgebung.

function required(name: string, fallback?: string): string {
	const v = process.env[name] ?? fallback;
	if (!v) throw new Error(`Umgebungsvariable ${name} fehlt`);
	return v;
}

/**
 * Die Adresse, unter der die Anwendung erreichbar ist, z.B.
 * "https://tracker.example.de". Muss exakt stimmen: WebAuthn prueft sie.
 */
export const ORIGIN = required("ORIGIN", "http://localhost:5173");

/**
 * Die Kennung, an die Passkeys gebunden sind - der Hostname ohne Schema und
 * Port.
 */
export const RP_ID = required("RP_ID", new URL(ORIGIN).hostname);

/** Der Name, den der Anmeldedialog des Betriebssystems anzeigt. */
export const RP_NAME = process.env.RP_NAME ?? "TimeTracker";

/** Herkuenfte, von denen schreibende Anfragen angenommen werden. */
export const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS ?? "")
	.split(",")
	.map((o) => o.trim().replace(/\/+$/, ""))
	.filter(Boolean)
	.concat(ORIGIN);

/**
 * Kann diese Kennung ueberhaupt eine Passkey-Kennung sein?
 *
 * IP-Adressen NICHT - WebAuthn verlangt einen Domainnamen. `localhost` ist die
 * Ausnahme, die auch ohne HTTPS geht; 127.0.0.1 ist fuer den Browser woanders.
 */
export function isValidRpId(rpId: string): boolean {
	if (rpId === "localhost") return true;
	// IPv4, IPv6 und alles, was keinen Punkt hat, scheidet aus.
	if (/^\d{1,3}(\.\d{1,3}){3}$/.test(rpId)) return false;
	if (rpId.includes(":")) return false;
	return rpId.includes(".");
}

/** Gehoert diese Adresse zu unserer Passkey-Kennung - gleiche Domain oder Unterdomain? */
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

/** Adressen, die zwar zugreifen duerfen, aber keine Passkeys tragen koennen. */
export const ORIGINS_WITHOUT_PASSKEY = ALLOWED_ORIGINS.filter((o) => !matchesRpId(o, RP_ID));

export const DATA_DIR = process.env.DATA_DIR ?? "./data";
export const DB_FILE = process.env.DB_FILE ?? `${DATA_DIR}/timetracker.db`;

/** Automatische Sicherungen: Intervall in Stunden (0 = aus, Standard 24h). */
export const BACKUP_INTERVAL_HOURS = Number(process.env.BACKUP_INTERVAL_HOURS ?? 24);
/** Wie viele automatische Sicherungen aufgehoben werden (Standard: 7). */
export const BACKUP_KEEP = Number(process.env.BACKUP_KEEP ?? 7);
/** Ordner fuer Sicherungen. */
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
 * Geheimer Schluessel fuer HMAC-Signaturen von Session-Tokens.
 * Wenn gesetzt: Session-Hashes sind nur mit diesem Schluessel gueltig (sicherer).
 * Wenn nicht gesetzt: Fallback auf einfaches SHA-256 (bisheriges Verhalten).
 * WICHTIG: Denselben Wert in docker-compose.yml / .env setzen und nie aendern -
 * sonst werden alle aktiven Sitzungen beim Neustart unguelig.
 */
export const HMAC_SECRET = process.env.HMAC_SECRET?.trim() || null;

/**
 * Der Ausweis, den die Tagesmeldung mitbringen muss.
 *
 * Derselbe Wert wie beim Bauen der Anwendung (`TELEMETRY_KEY`). Nicht gesetzt
 * heisst: der Endpunkt nimmt gar nichts an - ein offener Zaehler waere ein
 * Freibrief, DAU und Versionsliste mit Erfundenem zu fuellen.
 *
 * Kein echtes Geheimnis: der Schluessel steckt im ausgelieferten Bundle. Er
 * haelt Spam von aussen ab, nicht jemanden, der sich ein Release ansieht.
 */
export const TELEMETRY_KEY = process.env.TELEMETRY_KEY?.trim() || null;

// ---------- Grenzen ----------
//
// Von Anfang an da, nicht nachtraeglich: ein Konto ohne Obergrenze ist im
// offenen Betrieb eine Einladung, die Platte vollzuschreiben.

/** Groesse eines einzelnen Chiffrats in Byte. Ein Eintrag braucht ~400. */
export const MAX_RECORD_BYTES = 64 * 1024;
/** Datensaetze je Konto. Zehn Jahre Erfassung liegen bei ~50.000. */
export const MAX_RECORDS_PER_USER = 500_000;
/** Datensaetze in einem einzelnen Schreibvorgang. */
export const MAX_BATCH = 500;
/** Datensaetze je Seite beim Abholen. */
export const DEFAULT_PAGE = 500;
export const MAX_PAGE = 2000;
/**
 * Buckets in einem Filter beim Abholen.
 *
 * Die Prio-Menge braucht zwei bis drei; die Grenze haelt die IN-Liste unter dem,
 * was SQLite an Platzhaltern annimmt.
 */
export const MAX_BUCKETS = 64;
/** Gleichzeitige Ereignis-Verbindungen je Konto. */
export const MAX_STREAMS_PER_USER = 8;
/** Wie lange die Warteschleife eine Anfrage offen haelt. */
export const SYNC_WAIT_MS = Number(process.env.SYNC_WAIT_MS ?? 25_000);

/** Lebensdauer einer Browser-Sitzung. */
export const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;
/** Wie lange eine WebAuthn-Aufgabe gilt. */
export const CHALLENGE_TTL_MS = 5 * 60 * 1000;
/** Wie lange ein Kopplungscode gilt - kurz, er wird abgetippt, nicht verwahrt. */
export const PAIRING_TTL_MS = 10 * 60 * 1000;
