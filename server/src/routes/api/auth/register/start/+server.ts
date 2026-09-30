// Schritt 1 der Registrierung: Aufgabe stellen.
import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { registrationOptions } from "$lib/server/webauthn";
import { storeChallenge } from "$lib/server/auth";
import { checkInviteCode, readDisplayName } from "$lib/server/registration";
import { readJson } from "$lib/server/request";

export const POST: RequestHandler = async ({ locals, request }) => {
	const body = await readJson(request);
	// Leer ist erlaubt - wie in /api/auth/device. Dann steht später die Kennung
	// des Kontos da, und im Passkey-Verwalter der Name der Anwendung.
	const displayName = readDisplayName(body?.displayName, "");

	// Nur GEPRUEFT, nicht entwertet - das passiert erst beim tatsächlichen
	// Anlegen des Kontos, sonst verbraucht ein abgebrochener Versuch die Einladung.
	checkInviteCode(locals.db, body?.invite);

	const userId = crypto.randomUUID();
	const options = await registrationOptions(displayName, userId);
	const challengeId = storeChallenge(locals.db, options.challenge, "register", userId);
	return json({ challengeId, userId, options });
};
