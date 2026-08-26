// Was vor jeder Anfrage passiert: Datenbank bereitstellen und feststellen, wem
// die Anfrage gehoert.
import type { Handle } from "@sveltejs/kit";
import { openDb } from "$lib/server/db";
import { cleanupExpired, deviceFromToken, userFromSession } from "$lib/server/auth";
import { DB_FILE } from "$lib/server/config";
import { SESSION_COOKIE } from "$lib/server/session";
import {
	LIMIT_AUTH,
	LIMIT_PAIR_CLAIM,
	LIMIT_PAIR_START,
	LIMIT_RECOVER,
	istGesperrt,
	nimmVersuch,
	raeumeLimits,
	type LimitOptions
} from "$lib/server/limit";
import {
	ALLOWED_ORIGINS,
	istGueltigeKennung,
	ORIGINS_OHNE_PASSKEY,
	RP_ID,
	WEBAUTHN_ORIGINS
} from "$lib/server/config";

/** Die Bremse - fuer alles, was ohne Anmeldung erreichbar ist. */
const BREMSEN: [string, LimitOptions][] = [
	["/api/pair/claim", LIMIT_PAIR_CLAIM],
	["/api/pair/start", LIMIT_PAIR_START],
	["/api/auth/login", LIMIT_AUTH],
	["/api/auth/register", LIMIT_AUTH],
	["/api/auth/recover", LIMIT_RECOVER]
];

const { db } = openDb(DB_FILE);

/** Methoden, die etwas veraendern - nur fuer die zaehlt die Herkunft. */
const SCHREIBEND = new Set(["POST", "PUT", "PATCH", "DELETE"]);

// Beim Start sagen, was mit den Adressen ist.
if (ORIGINS_OHNE_PASSKEY.length > 0) {
	console.warn("");
	console.warn(
		`Achtung: ${ORIGINS_OHNE_PASSKEY.length} Adresse(n) liegen nicht unter RP_ID="${RP_ID}":`
	);
	for (const o of ORIGINS_OHNE_PASSKEY) console.warn(`  ${o}`);
	console.warn("Dort funktionieren keine Passkeys. Zugreifen darf man trotzdem -");
	console.warn("ein gekoppeltes Gerät weist sich mit seinem Token aus.");
	console.warn("");
}
if (!istGueltigeKennung(RP_ID)) {
	// Der Fall, den man sonst erst im Browser sieht - und dort mit einer Meldung,
	// die nach einem Fehler der Anwendung aussieht: "127.0.0.1 is an invalid
	// domain". Es ist keiner. WebAuthn verlangt einen Domainnamen.
	console.warn("");
	console.warn(`Achtung: RP_ID="${RP_ID}" kann keine Passkey-Kennung sein.`);
	console.warn("WebAuthn verlangt einen Domainnamen. IP-Adressen gehen nicht -");
	console.warn("der Browser weist sie ab, egal was hier steht.");
	console.warn("");
	console.warn("  Zum Ausprobieren:  RP_ID=localhost, ORIGIN=http://localhost:3000");
	console.warn("                     und die Seite ueber localhost aufrufen, NICHT 127.0.0.1");
	console.warn("  Im Betrieb:        die endgueltige Domain, z. B. RP_ID=example.de");
	console.warn("");
} else if (WEBAUTHN_ORIGINS.length === 0) {
	console.warn("");
	console.warn(`Achtung: KEINE Adresse liegt unter RP_ID="${RP_ID}".`);
	console.warn("Niemand kann sich registrieren oder anmelden. Passt ORIGIN zu RP_ID?");
	console.warn("");
}

cleanupExpired(db);
// Stuendlich, damit abgebrochene Anmeldeversuche und abgelaufene Sitzungen nicht
// unbegrenzt liegen bleiben. `unref`, damit dieser Zeitgeber den Prozess beim
// Herunterfahren nicht offenhaelt.
setInterval(() => {
	cleanupExpired(db);
	raeumeLimits();
}, 3600_000).unref();

/** Kommt diese Anfrage von der Seite, die dieser Server selbst ausliefert? */
function istEigeneHerkunft(herkunft: string, headers: Headers): boolean {
	// Hinter einem Reverse-Proxy steht der echte Name in der weitergereichten
	// Kopfzeile; ohne Proxy im gewoehnlichen Host.
	const host = headers.get("x-forwarded-host") ?? headers.get("host");
	if (!host) return false;
	try {
		return new URL(herkunft).host === host;
	} catch {
		// Ein Origin, der keine Adresse ist, ist keine eigene Herkunft.
		return false;
	}
}

/** Die Adresse des Aufrufers - oder ein Ersatz. */
function herkunftsAdresse(event: Parameters<Handle>[0]["event"]): string {
	try {
		return event.getClientAddress();
	} catch {
		return "ohne-adresse";
	}
}

export const handle: Handle = async ({ event, resolve }) => {
	const pfad = event.url.pathname;

	// Erst bremsen, dann arbeiten: eine Pruefung, die nach der teuren Abfrage
	// kommt, bremst den Angreifer nicht, sondern nur den Server.
	const bremse = BREMSEN.find(([p]) => pfad.startsWith(p));
	const bremsSchluessel = bremse ? `${bremse[0]}|${herkunftsAdresse(event)}` : "";
	// Beim Abfragen eines Kopplungsvorgangs zaehlen nur Fehlgriffe, und das
	// entscheidet erst die Antwort - hier nur nachsehen, gezaehlt wird unten.
	const nurFehlgriffe = pfad.startsWith("/api/pair/claim");

	if (bremse) {
		const gesperrt = nurFehlgriffe
			? istGesperrt(bremsSchluessel, bremse[1])
			: !nimmVersuch(bremsSchluessel, bremse[1]).erlaubt;
		if (gesperrt) {
			return new Response(JSON.stringify({ message: "Zu viele Versuche" }), {
				status: 429,
				headers: { "content-type": "application/json", "retry-after": "60" }
			});
		}
	}

	// CSRF-Schutz - nur fuer Anfragen MIT Sitzungs-Cookie: nur der faehrt automatisch
	// mit. Ein Geraete-Token wird gesetzt, eine Anfrage ohne beides ist anonym.
	const mitCookie = event.cookies.get(SESSION_COOKIE) !== undefined;
	if (mitCookie && SCHREIBEND.has(event.request.method) && pfad.startsWith("/api/")) {
		const herkunft = event.request.headers.get("origin");
		const eigene = herkunft !== null && istEigeneHerkunft(herkunft, event.request.headers);
		if (herkunft && !eigene && !ALLOWED_ORIGINS.includes(herkunft)) {
			return new Response(JSON.stringify({ message: "Herkunft nicht erlaubt" }), {
				status: 403,
				headers: { "content-type": "application/json" }
			});
		}
	}

	event.locals.db = db;
	event.locals.userId = null;
	event.locals.deviceId = null;

	// Das Token zuerst: es ist die ausdruecklichere Angabe als ein Cookie.
	const auth = event.request.headers.get("authorization");
	if (auth?.startsWith("Bearer ")) {
		const device = deviceFromToken(db, auth.slice(7));
		if (device) {
			event.locals.userId = device.userId;
			event.locals.deviceId = device.deviceId;
		}
	}

	if (!event.locals.userId) {
		const cookie = event.cookies.get(SESSION_COOKIE);
		if (cookie) event.locals.userId = userFromSession(db, cookie);
	}

	const antwort = await resolve(event);

	// Erst jetzt steht fest, ob es ein Fehlgriff war: 404 heisst vertippt oder
	// geraten, alles andere ist ein Mensch, der auf die Bestaetigung wartet.
	if (bremse && nurFehlgriffe && antwort.status === 404) {
		nimmVersuch(bremsSchluessel, bremse[1]);
	}

	return antwort;
};
