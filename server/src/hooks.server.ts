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

// Beim Start sagen, was mit den Adressen ist.
//
// Die haeufigste Ursache dafuer, dass Passkeys "einfach nicht gehen", ist eine
// Adresse, die nicht unter der RP-Kennung liegt. Der Browser meldet das mit
// einem Text, den niemand mit dieser Einstellung in Verbindung bringt - also
// gehoert es hierher, wo es beim Hochfahren ins Auge faellt.
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

/**
 * Kommt diese Anfrage von der Seite, die dieser Server selbst ausliefert?
 *
 * Verglichen wird der Origin-Kopf mit dem Host, an den die Anfrage GING - nicht
 * mit ORIGIN aus der Umgebung. Das ist der Unterschied, an dem der erste Anlauf
 * scheiterte: `event.url` baut adapter-node aus ORIGIN zusammen, es steht also
 * immer dasselbe darin, egal ueber welchen Namen jemand hereinkam. Damit war
 * jeder ausgesperrt, der den Dienst nicht exakt so aufrief wie ORIGIN es sagt -
 * ueber 127.0.0.1 statt localhost, ueber den Rechnernamen, ueber die Adresse im
 * Heimnetz.
 *
 * Warum das trotzdem schuetzt: beide Koepfe setzt der Browser, nicht die Seite.
 * Eine fremde Seite bekommt ihren eigenen Namen in `origin` eingetragen und kann
 * daran nichts aendern - sie stimmt dann nicht mit dem Host ueberein, an den die
 * Anfrage geht. Genau das soll abgewiesen werden.
 */
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
	const bremsSchluessel = bremse ? `${bremse[0]}|${herkunftsAdresse(event)}` : "";
	// Beim Abfragen eines Kopplungsvorgangs zaehlen nur Fehlgriffe - das
	// entscheidet erst die Antwort. Hier wird deshalb nur nachgesehen, ob schon
	// gesperrt ist; gezaehlt wird unten.
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

	// Herkunft pruefen - aber nur, wo sie ueberhaupt etwas schuetzt.
	//
	// Wovor: eine fremde Seite im Browser schickt eine Anfrage an unseren Server,
	// und das Sitzungs-Cookie des Angemeldeten faehrt automatisch mit. Er hat
	// nichts getan und nichts gesehen; geschrieben wurde trotzdem in seinem Namen.
	//
	// Daran haengt die ganze Pruefung - am AUTOMATISCH mitfahrenden Ausweis. Wo
	// kein Cookie mitkommt, gibt es nichts zu missbrauchen: ein Geraete-Token
	// muss ausdruecklich gesetzt werden, und wer es hat, braucht keine fremde
	// Seite. Eine Anfrage ohne beides ist anonym und kann nichts erschleichen,
	// was ihr nicht ohnehin offensteht.
	//
	// Der erste Anlauf pruefte jede schreibende Anfrage und nahm nur die mit
	// Token aus. Das ging schief bei der einen, die beides nicht hat: dem Anlegen
	// eines Kontos aus der Desktop-Anwendung heraus. Sie schickt
	// `Origin: http://tauri.localhost` - ein Fenster hat nun einmal eine Herkunft -
	// und wurde mit "Herkunft nicht erlaubt" abgewiesen, bevor sie ueberhaupt
	// beginnen konnte.
	//
	// Verglichen wird gegen den Host, an den die Anfrage ging, nicht gegen ORIGIN
	// aus der Umgebung: derselbe Dienst ist ueber localhost, 127.0.0.1, den
	// Rechnernamen und die Adresse im Heimnetz erreichbar, und unter jedem dieser
	// Namen ist die eigene Seite dieselbe Seite.
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

	const antwort = await resolve(event);

	// Erst jetzt steht fest, ob es ein Fehlgriff war. 404 heisst: den Code gibt es
	// nicht - also entweder vertippt oder geraten. Alles andere ist ein Mensch,
	// der auf eine Bestaetigung wartet, und der wird nicht ausgebremst.
	if (bremse && nurFehlgriffe && antwort.status === 404) {
		nimmVersuch(bremsSchluessel, bremse[1]);
	}

	return antwort;
};
