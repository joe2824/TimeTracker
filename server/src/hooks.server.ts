// Was vor jeder Anfrage passiert: Datenbank bereitstellen und feststellen, wem
// die Anfrage gehoert.
import type { Handle } from "@sveltejs/kit";
import { randomBytes } from "node:crypto";
import { openDb } from "$lib/server/db";
import { cleanupExpired, deviceFromToken, userFromSession } from "$lib/server/auth";
import { startBackupScheduler } from "$lib/server/backup";
import { DB_FILE } from "$lib/server/config";
import { SESSION_COOKIE, setSessionCookie } from "$lib/server/session";
import {
	LIMIT_AUTH,
	LIMIT_AUTH_START,
	LIMIT_PAIR_CLAIM,
	LIMIT_PAIR_START,
	LIMIT_RECOVER,
	LIMIT_TELEMETRY,
	isLocked,
	takeAttempt,
	cleanupLimits,
	type LimitOptions
} from "$lib/server/limit";

import { cleanupOldTelemetry } from "$lib/server/stats";
import {
	ALLOWED_ORIGINS,
	HMAC_SECRET,
	isValidRpId,
	ORIGIN,
	ORIGINS_WITHOUT_PASSKEY,
	RP_ID,
	SERVER_VERSION,
	WEBAUTHN_ORIGINS
} from "$lib/server/config";

/** Die Bremse - fuer alles, was ohne Anmeldung erreichbar ist. */
const RATE_LIMITS: [string, LimitOptions][] = [
	["/api/pair/claim", LIMIT_PAIR_CLAIM],
	["/api/pair/start", LIMIT_PAIR_START],
	// Vor dem allgemeinen Satz: `find` nimmt den ersten Treffer.
	["/api/auth/login/start", LIMIT_AUTH_START],
	["/api/auth/login", LIMIT_AUTH],
	["/api/auth/register", LIMIT_AUTH],
	["/api/auth/recover", LIMIT_RECOVER],
	["/api/telemetry", LIMIT_TELEMETRY]
];


const { db, raw } = openDb(DB_FILE);
startBackupScheduler(raw);

/** Methoden, die etwas veraendern - nur fuer die zaehlt die Herkunft. */
const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

// Beim Start Version, Erreichbarkeits-Adresse und Sicherheitsstatus melden.
console.log(`[Server] TimeTracker Server v${SERVER_VERSION} (Node ${process.version})`);
console.log(`[Server] Adresse:        ${ORIGIN} (RP_ID: ${RP_ID})`);
if (HMAC_SECRET) {
	console.log(`[Server] HMAC_SECRET:   Aktiv (Session-Tokens werden per HMAC-SHA256 signiert)`);
} else {
	console.log(`[Server] HMAC_SECRET:   Nicht gesetzt (Fallback auf SHA-256 ohne Schlüssel)`);
	console.warn(`[Security] Empfehlung: HMAC_SECRET=$(openssl rand -hex 32) in .env hinterlegen.`);
}

// Beim Start sagen, was mit den Adressen ist.
if (ORIGINS_WITHOUT_PASSKEY.length > 0) {
	console.warn("");
	console.warn(
		`Achtung: ${ORIGINS_WITHOUT_PASSKEY.length} Adresse(n) liegen nicht unter RP_ID="${RP_ID}":`
	);
	for (const o of ORIGINS_WITHOUT_PASSKEY) console.warn(`  ${o}`);
	console.warn("Dort funktionieren keine Passkeys. Zugreifen darf man trotzdem -");
	console.warn("ein gekoppeltes Gerät weist sich mit seinem Token aus.");
	console.warn("");
}
if (!isValidRpId(RP_ID)) {
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
cleanupOldTelemetry(raw);
// Stuendlich, damit abgebrochene Anmeldeversuche und abgelaufene Sitzungen nicht
// unbegrenzt liegen bleiben. `unref`, damit dieser Zeitgeber den Prozess beim
// Herunterfahren nicht offenhaelt.
setInterval(() => {
	cleanupExpired(db);
	cleanupLimits();
	cleanupOldTelemetry(raw);
}, 3600_000).unref();



/** Kommt diese Anfrage von der Seite, die dieser Server selbst ausliefert? */
function isOwnOrigin(originValue: string, headers: Headers): boolean {
	// Hinter einem Reverse-Proxy steht der echte Name in der weitergereichten
	// Kopfzeile; ohne Proxy im gewoehnlichen Host.
	const host = headers.get("x-forwarded-host") ?? headers.get("host");
	if (!host) return false;
	try {
		return new URL(originValue).host === host;
	} catch {
		// Ein Origin, der keine Adresse ist, ist keine eigene Herkunft.
		return false;
	}
}

/** Die Adresse des Aufrufers - oder ein Ersatz. */
function originAddress(event: Parameters<Handle>[0]["event"]): string {
	try {
		return event.getClientAddress();
	} catch {
		return "ohne-adresse";
	}
}

export const handle: Handle = async ({ event, resolve }) => {
	const urlPath = event.url.pathname;

	// Erst bremsen, dann arbeiten: eine Pruefung, die nach der teuren Abfrage
	// kommt, bremst den Angreifer nicht, sondern nur den Server.
	const rateLimit = RATE_LIMITS.find(([p]) => urlPath.startsWith(p));
	const limitKey = rateLimit ? `${rateLimit[0]}|${originAddress(event)}` : "";
	// Beim Abfragen eines Kopplungsvorgangs zaehlen nur Fehlgriffe, und das
	// entscheidet erst die Antwort - hier nur nachsehen, gezaehlt wird unten.
	const onlyFailures = urlPath.startsWith("/api/pair/claim");

	if (rateLimit) {
		const locked = onlyFailures
			? isLocked(limitKey, rateLimit[1])
			: !takeAttempt(limitKey, rateLimit[1]).allowed;
		if (locked) {
			return new Response(JSON.stringify({ message: "Zu viele Versuche" }), {
				status: 429,
				headers: { "content-type": "application/json", "retry-after": "60" }
			});
		}
	}

	// CSRF-Schutz - nur fuer Anfragen MIT Sitzungs-Cookie: nur der faehrt automatisch
	// mit. Ein Geraete-Token wird gesetzt, eine Anfrage ohne beides ist anonym.
	const withCookie = event.cookies.get(SESSION_COOKIE) !== undefined;
	if (withCookie && WRITE_METHODS.has(event.request.method) && urlPath.startsWith("/api/")) {
		const originValue = event.request.headers.get("origin");
		const own = originValue !== null && isOwnOrigin(originValue, event.request.headers);
		if (originValue && !own && !ALLOWED_ORIGINS.includes(originValue)) {
			return new Response(JSON.stringify({ message: "Herkunft nicht erlaubt" }), {
				status: 403,
				headers: { "content-type": "application/json" }
			});
		}
	}

	event.locals.db = db;
	event.locals.raw = raw;
	event.locals.dbPath = DB_FILE;
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
		const session = cookie ? userFromSession(db, cookie) : null;
		if (session) {
			event.locals.userId = session.userId;
			// Die Frist im Cookie laeuft ab dem Setzen - sie muss mitwandern, sonst
			// meldet der Browser nach 30 Tagen ab, obwohl der Server laengst
			// verlaengert hat.
			if (session.slid) setSessionCookie(event.cookies, cookie!);
		}
	}

	const answer = await resolve(event);

	// Standard-Sicherheits-Header
	answer.headers.set("x-content-type-options", "nosniff");
	answer.headers.set("x-frame-options", "DENY");
	answer.headers.set("referrer-policy", "strict-origin-when-cross-origin");
	answer.headers.set("permissions-policy", "camera=(), microphone=(), geolocation=()");

	const contentType = answer.headers.get("content-type") ?? "";
	if (contentType.includes("text/html")) {
		answer.headers.set(
			"content-security-policy",
			"default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' ws: wss:; font-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none';"
		);
	}

	// Erst jetzt steht fest, ob es ein Fehlgriff war: 404 heisst vertippt oder
	// geraten, alles andere ist ein Mensch, der auf die Bestaetigung wartet.
	if (rateLimit && onlyFailures && answer.status === 404) {
		takeAttempt(limitKey, rateLimit[1]);
	}

	return answer;
};
