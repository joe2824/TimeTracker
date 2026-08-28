import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { verifyAuthentication } from "$lib/server/webauthn";
import { createSession, takeChallenge } from "$lib/server/auth";
import { users } from "$lib/server/db/schema";
import { eq } from "drizzle-orm";
import { setSessionCookie } from "$lib/server/session";

export const POST: RequestHandler = async ({ locals, request, cookies }) => {
	const body = await request.json().catch(() => null);
	const taken = takeChallenge(locals.db, String(body?.challengeId ?? ""), "login");
	if (!taken) error(400, "Aufgabe abgelaufen – bitte erneut versuchen");

	const result = await verifyAuthentication(locals.db, body?.response, taken.challenge);
	// Absichtlich dieselbe Meldung fuer "Passkey unbekannt" und "Antwort falsch":
	// sonst laesst sich herausfinden, welche Passkeys es gibt.
	if (!result) error(401, "Anmeldung fehlgeschlagen");

	const user = locals.db.select().from(users).where(eq(users.id, result.userId)).get();
	if (!user) error(401, "Anmeldung fehlgeschlagen");

	setSessionCookie(cookies, createSession(locals.db, result.userId));
	return json({ userId: user.id, displayName: user.displayName, credentialId: result.credentialId });
};
