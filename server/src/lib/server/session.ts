// Das Sitzungs-Cookie.
import type { Cookies } from "@sveltejs/kit";
import { SESSION_TTL_MS } from "./config";

// In Produktion erzwingt das __Host--Praefix auf Browserebene:
// Secure, HttpOnly, kein Domain-Attribut, kein Subdomain-Cookie-Theft.
// In der Entwicklung (localhost/HTTP) ist das Praefix unzulaessig - daher konditionell.
export const SESSION_COOKIE =
	process.env.NODE_ENV === "production" ? "__Host-tt_session" : "tt_session";

export function setSessionCookie(cookies: Cookies, secret: string): void {
	cookies.set(SESSION_COOKIE, secret, {
		path: "/",
		httpOnly: true,
		// "lax" statt "strict": ein Magic-Link aus einer Mail soll den Angemeldeten
		// nicht auf einer Anmeldeseite herauskommen lassen. Schreibende Anfragen
		// sind zusaetzlich ueber die Herkunftspruefung abgesichert.
		sameSite: "lax",
		// Ueber eine unverschluesselte Verbindung gibt es kein Secure-Cookie - sonst
		// waere die Anwendung auf localhost nicht zu entwickeln.
		secure: process.env.NODE_ENV === "production",
		maxAge: Math.floor(SESSION_TTL_MS / 1000)
	});
}

export function clearSessionCookie(cookies: Cookies): void {
	cookies.delete(SESSION_COOKIE, { path: "/" });
}
