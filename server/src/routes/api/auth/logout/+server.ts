import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { destroySession } from "$lib/server/auth";
import { SESSION_COOKIE, clearSessionCookie } from "$lib/server/session";

export const POST: RequestHandler = ({ locals, cookies }) => {
	const secret = cookies.get(SESSION_COOKIE);
	// Auch serverseitig loeschen, nicht nur das Cookie wegnehmen: sonst bliebe
	// eine kopierte Sitzung gueltig, bis sie von selbst ablaeuft.
	if (secret) destroySession(locals.db, secret);
	clearSessionCookie(cookies);
	return json({ ok: true });
};
