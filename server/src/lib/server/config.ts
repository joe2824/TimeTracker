// Die Betriebseinstellungen, alle aus der Umgebung.
//
// Absichtlich an einer Stelle und mit sprechenden Fehlern: die haeufigste
// Ursache dafuer, dass Passkeys "einfach nicht gehen", ist eine RP_ID, die nicht
// zur Adresse passt. Das soll beim Start auffallen und nicht erst, wenn sich
// jemand nicht anmelden kann.

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
 *
 * ACHTUNG: Passkeys ueberleben keinen Wechsel. Wird der Dienst spaeter auf eine
 * andere Domain umgezogen, sind ALLE registrierten Passkeys wertlos und jeder
 * muss sich ueber die Wiederherstellungs-Phrase neu einrichten. Deshalb von
 * Anfang an die endgueltige Domain nehmen, auch solange der Container nur im
 * Heimnetz erreichbar ist.
 */
export const RP_ID = required("RP_ID", new URL(ORIGIN).hostname);

/** Der Name, den der Anmeldedialog des Betriebssystems anzeigt. */
export const RP_NAME = process.env.RP_NAME ?? "TimeTracker";

export const DATA_DIR = process.env.DATA_DIR ?? "./data";
export const DB_FILE = process.env.DB_FILE ?? `${DATA_DIR}/timetracker.db`;

/**
 * Einladungscodes, durch Komma getrennt.
 *
 * Solange hier etwas steht, ist die Registrierung geschlossen. Leer heisst
 * offen - das ist eine bewusste Entscheidung und keine, in die man
 * hineinrutschen sollte.
 */
export const INVITE_CODES = (process.env.INVITE_CODES ?? "")
	.split(",")
	.map((c) => c.trim())
	.filter(Boolean);

export const REGISTRATION_OPEN = INVITE_CODES.length === 0;

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
/** Gleichzeitige Ereignis-Verbindungen je Konto. */
export const MAX_STREAMS_PER_USER = 8;

/** Lebensdauer einer Browser-Sitzung. */
export const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;
/** Wie lange eine WebAuthn-Aufgabe gilt. */
export const CHALLENGE_TTL_MS = 5 * 60 * 1000;
/** Wie lange ein Kopplungscode gilt - kurz, er wird abgetippt, nicht verwahrt. */
export const PAIRING_TTL_MS = 10 * 60 * 1000;
