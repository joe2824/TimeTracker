// Was vor jeder Anfrage passiert: Datenbank bereitstellen und feststellen, wem
// die Anfrage gehoert.
//
// Ab hier arbeitet jeder Endpunkt nur noch mit `locals.userId` - und schraenkt
// JEDE Abfrage darauf ein. Das ist die gesamte Mandantentrennung, und sie ist
// deshalb so knapp, weil sie an genau einer Stelle passiert.
import type { Handle } from "@sveltejs/kit";
import { openDb } from "$lib/server/db";
import { cleanupExpired, deviceFromToken, userFromSession } from "$lib/server/auth";
import { DB_FILE } from "$lib/server/config";
import { SESSION_COOKIE } from "$lib/server/session";
import {
	LIMIT_AUTH,
	LIMIT_PAIR_CLAIM,
	LIMIT_PAIR_START,
	nimmVersuch,
	raeumeLimits,
	type LimitOptions
} from "$lib/server/limit";
import { ALLOWED_ORIGINS } from "$lib/server/config";

/**
 * Die Bremse - fuer alles, was ohne Anmeldung erreichbar ist.
 *
 * Hier zentral und nicht in den Routen: eine Liste, die man beim Anlegen eines
 * Endpunkts uebersieht, ist schlimmer als keine, weil sie den Eindruck erweckt,
 * es sei geregelt.
 *
 * Was NICHT drinsteht, braucht keine Bremse: alles Uebrige verlangt eine
 * Anmeldung, und wer eine hat, kann sich ohnehin nichts erschleichen, was ihm
 * nicht gehoert.
 */
const BREMSEN: [string, LimitOptions][] = [
	["/api/pair/claim", LIMIT_PAIR_CLAIM],
	["/api/pair/start", LIMIT_PAIR_START],
	["/api/auth/login", LIMIT_AUTH],
	["/api/auth/register", LIMIT_AUTH]
];

const { db } = openDb(DB_FILE);

/** Methoden, die etwas veraendern - nur fuer die zaehlt die Herkunft. */
const SCHREIBEND = new Set(["POST", "PUT", "PATCH", "DELETE"]);

cleanupExpired(db);
// Stuendlich, damit abgebrochene Anmeldeversuche und abgelaufene Sitzungen nicht
// unbegrenzt liegen bleiben. `unref`, damit dieser Zeitgeber den Prozess beim
// Herunterfahren nicht offenhaelt.
setInterval(() => {
	cleanupExpired(db);
	raeumeLimits();
}, 3600_000).unref();

/**
 * Die Adresse des Aufrufers - oder ein Ersatz.
 *
 * `getClientAddress()` WIRFT, wenn ADDRESS_HEADER gesetzt ist und der Header
 * fehlt. Genau das ist der Fall, wenn jemand den Container direkt anspricht
 * statt ueber den Reverse-Proxy - beim ersten Ausprobieren also fast immer.
 *
 * Ungefangen legt das jeden gebremsten Endpunkt lahm: Registrierung und
 * Kopplung antworten dann mit einem Serverfehler, und niemand kaeme auf die
 * Ursache. Der Ersatzschluessel bedeutet, dass sich alle Aufrufer ohne Header
 * einen Eimer teilen - hinter dem Proxy, fuer den die Einstellung gedacht ist,
 * tritt das nie ein.
 */
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
	if (bremse) {
		const { erlaubt, retryAfter } = nimmVersuch(`${bremse[0]}|${herkunftsAdresse(event)}`, bremse[1]);
		if (!erlaubt) {
			return new Response(JSON.stringify({ message: "Zu viele Versuche" }), {
				status: 429,
				headers: { "content-type": "application/json", "retry-after": String(retryAfter) }
			});
		}
	}

	// Herkunft pruefen, wo geschrieben wird.
	//
	// SvelteKit prueft von sich aus nur die Inhaltsarten, die ein HTML-Formular
	// abschicken kann. Unsere Endpunkte lesen den Rumpf aber unabhaengig davon
	// als JSON - die Pruefung gehoert deshalb ausdruecklich hierher und nicht in
	// das Vertrauen darauf, dass ein Browser schon einen Vorabruf schickt.
	//
	// Anfragen mit Geraete-Token sind ausgenommen: sie tragen ihren Ausweis
	// selbst und kommen aus einer Anwendung, deren Herkunft kein Server sinnvoll
	// erlauben kann.
	if (SCHREIBEND.has(event.request.method) && pfad.startsWith("/api/")) {
		const herkunft = event.request.headers.get("origin");
		const mitToken = event.request.headers.get("authorization")?.startsWith("Bearer ");
		if (herkunft && !mitToken && !ALLOWED_ORIGINS.includes(herkunft)) {
			return new Response(JSON.stringify({ message: "Herkunft nicht erlaubt" }), {
				status: 403,
				headers: { "content-type": "application/json" }
			});
		}
	}

	event.locals.db = db;
	event.locals.userId = null;
	event.locals.deviceId = null;

	// Das Geraete-Token zuerst: der Desktop schickt kein Cookie, und ein
	// mitgeschicktes Token ist die ausdruecklichere Angabe.
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

	return resolve(event);
};
