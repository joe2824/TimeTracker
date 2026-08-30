// Schritt 1 der Registrierung: Aufgabe stellen.
import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { registrationOptions } from "$lib/server/webauthn";
import { storeChallenge } from "$lib/server/auth";
import { gueltigerCode, istRegistrierungOffen } from "$lib/server/invites";

export const POST: RequestHandler = async ({ locals, request }) => {
	const body = await request.json().catch(() => null);
	// Leer ist erlaubt - wie in /api/auth/device. Dann steht spaeter die Kennung
	// des Kontos da, und im Passkey-Verwalter der Name der Anwendung.
	const displayName = String(body?.displayName ?? "").trim();
	if (displayName.length > 64) error(400, "Anzeigename ist zu lang");

	// Nur GEPRUEFT, nicht entwertet - das passiert erst beim tatsaechlichen
	// Anlegen des Kontos, sonst verbraucht ein abgebrochener Versuch die Einladung.
	if (!istRegistrierungOffen(locals.db)) {
		const code = String(body?.invite ?? "").trim();
		if (!gueltigerCode(locals.db, code)) error(403, "Einladungscode ungültig");
	}

	const userId = crypto.randomUUID();
	const options = await registrationOptions(displayName, userId);
	const challengeId = storeChallenge(locals.db, options.challenge, "register", userId);
	return json({ challengeId, userId, options });
};
