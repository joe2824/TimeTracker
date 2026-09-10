// Was vor jeder Anfrage passiert: Datenbank bereitstellen und feststellen, wem
// die Anfrage gehört.
import type { Handle } from "@sveltejs/kit";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { openDb } from "$lib/server/db";
import { cleanupExpired, deviceFromToken, userFromSession } from "$lib/server/auth";
import { teamMemberFromToken } from "$lib/server/teams";
import { startBackupScheduler } from "$lib/server/backup";
import { APP_SHELL_FILE, CLIENT_DIR, DB_FILE } from "$lib/server/config";
import { SESSION_COOKIE, setSessionCookie } from "$lib/server/session";
import {
	LIMIT_AUTH,
	LIMIT_AUTH_START,
	LIMIT_PAIR_CLAIM,
	LIMIT_PAIR_START,
	LIMIT_RECOVER,
	LIMIT_TELEMETRY,
	LIMIT_TEAM_JOIN,
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

/** Die Bremse - für alles, was ohne Anmeldung erreichbar ist. */
const RATE_LIMITS: [string, LimitOptions][] = [
	["/api/pair/claim", LIMIT_PAIR_CLAIM],
	["/api/pair/start", LIMIT_PAIR_START],
	// Vor dem allgemeinen Satz: `find` nimmt den ersten Treffer.
	["/api/auth/login/start", LIMIT_AUTH_START],
	["/api/auth/login", LIMIT_AUTH],
	["/api/auth/register", LIMIT_AUTH],
	// Der Weg vom Rechner aus legt ein Konto samt Gerät an, ohne Passkey und
	// ohne Sitzung - dieselbe Bremse wie für die Registrierung im Browser. Ohne
	// sie liesse sich der Endpunkt bei offener Registrierung in einer Schleife
	// aufrufen, und jede Runde kostet eine Konto- und eine Gerätezeile.
	["/api/auth/device", LIMIT_AUTH],
	["/api/auth/recover", LIMIT_RECOVER],
	["/api/telemetry", LIMIT_TELEMETRY],
	["/api/team/join", LIMIT_TEAM_JOIN]
];


const { db, raw } = openDb(DB_FILE);
startBackupScheduler(raw);

/**
 * `script-src` aus dem CSP-Meta-Tag übernehmen, das SvelteKit beim Bauen in
 * die App-Shell legt (svelte.config.js, `csp.mode: "hash"`) - so erlaubt die
 * Kopfzeile denselben Inline-Bootstrap-Code wie das Meta-Tag, statt pauschal
 * `'unsafe-inline'`. Eine Kopie des Hash-Werts wäre zwei Stellen, die
 * auseinanderlaufen könnten - der Wert wird deshalb aus der Datei gelesen,
 * nicht selbst gerechnet. Fehlt Datei oder Tag (z.B. lokal ohne Bau, oder
 * bevor die PWA das erste Mal gebaut wurde), bleibt `'unsafe-inline'` als
 * Rückfall - besser eine laxere Kopfzeile als eine App, die gar nicht startet.
 */
const SCRIPT_SRC = (() => {
	try {
		const html = readFileSync(join(CLIENT_DIR, APP_SHELL_FILE), "utf-8");
		const meta = html.match(/<meta[^>]*content-security-policy[^>]*content="([^"]*)"/i)?.[1];
		return meta?.match(/script-src ([^;]+)/i)?.[1].trim() ?? "'self' 'unsafe-inline'";
	} catch {
		return "'self' 'unsafe-inline'";
	}
})();

/** Methoden, die etwas veraendern - nur für die zaehlt die Herkunft. */
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
// Stündlich, damit abgebrochene Anmeldeversuche und abgelaufene Sitzungen nicht
// unbegrenzt liegen bleiben. `unref`, damit dieser Zeitgeber den Prozess beim
// Herunterfahren nicht offenhält.
setInterval(() => {
	cleanupExpired(db);
	cleanupLimits();
	cleanupOldTelemetry(raw);
}, 3600_000).unref();



/** Kommt diese Anfrage von der Seite, die dieser Server selbst ausliefert? */
function isOwnOrigin(originValue: string, headers: Headers): boolean {
	// Hinter einem Reverse-Proxy steht der echte Name in der weitergereichten
	// Kopfzeile; ohne Proxy im gewöhnlichen Host.
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

	// Erst bremsen, dann arbeiten: eine Prüfung, die nach der teuren Abfrage
	// kommt, bremst den Angreifer nicht, sondern nur den Server.
	const rateLimit = RATE_LIMITS.find(([p]) => urlPath.startsWith(p));
	// Methode mit im Schlüssel: /api/team/join hat ein GET (Vorschau, feuert
	// automatisch beim Öffnen des Beitritts-Dialogs) UND ein POST (der echte
	// Beitritt) - ohne die Trennung verbrauchten ein paar Dialog-Öffnungen das
	// Kontingent, das der eigentliche Beitritt braucht.
	const limitKey = rateLimit ? `${rateLimit[0]}|${event.request.method}|${originAddress(event)}` : "";
	// Beim Abfragen eines Kopplungsvorgangs zählen nur Fehlgriffe, und das
	// entscheidet erst die Antwort - hier nur nachsehen, gezählt wird unten.
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

	// CSRF-Schutz - nur für Anfragen MIT Sitzungs-Cookie: nur der fährt automatisch
	// mit. Ein Geräte-Token wird gesetzt, eine Anfrage ohne beides ist anonym.
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
	event.locals.teamMemberId = null;
	event.locals.teamId = null;

	// Das Token zuerst: es ist die ausdrücklichere Angabe als ein Cookie.
	const auth = event.request.headers.get("authorization");
	if (auth?.startsWith("Bearer ")) {
		const device = deviceFromToken(db, auth.slice(7));
		if (device) {
			event.locals.userId = device.userId;
			event.locals.deviceId = device.deviceId;
		}
	}

	// Eigener Kopf, eigener Token-Raum: ein Team-Mitglied hat kein Personenkonto
	// und darf mit userId/deviceId nicht verwechselt werden.
	const teamAuth = event.request.headers.get("x-team-token");
	if (teamAuth) {
		const member = teamMemberFromToken(db, teamAuth);
		if (member) {
			event.locals.teamMemberId = member.teamMemberId;
			event.locals.teamId = member.teamId;
		}
	}

	if (!event.locals.userId) {
		const cookie = event.cookies.get(SESSION_COOKIE);
		const session = cookie ? userFromSession(db, cookie) : null;
		if (session) {
			event.locals.userId = session.userId;
			// Die Frist im Cookie läuft ab dem Setzen - sie muss mitwandern, sonst
			// meldet der Browser nach 30 Tagen ab, obwohl der Server längst
			// verlängert hat.
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
			`default-src 'self'; script-src ${SCRIPT_SRC}; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' ws: wss:; font-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none';`
		);
	}

	// Erst jetzt steht fest, ob es ein Fehlgriff war: 404 heisst vertippt oder
	// geraten, alles andere ist ein Mensch, der auf die Bestätigung wartet.
	if (rateLimit && onlyFailures && answer.status === 404) {
		takeAttempt(limitKey, rateLimit[1]);
	}

	return answer;
};
