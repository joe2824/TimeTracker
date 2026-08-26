// Schritt 1 der Registrierung: Aufgabe stellen.
import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { registrationOptions } from "$lib/server/webauthn";
import { storeChallenge } from "$lib/server/auth";
import { REGISTRATION_OPEN } from "$lib/server/config";
import { gueltigerCode } from "$lib/server/invites";

export const POST: RequestHandler = async ({ locals, request }) => {
	const body = await request.json().catch(() => null);
	const displayName = String(body?.displayName ?? "").trim();
	if (!displayName || displayName.length > 64) error(400, "Anzeigename fehlt oder ist zu lang");

	// Geschlossener Betrieb: der Code wird hier nur GEPRUEFT, nicht entwertet.
	// Entwertet wird er erst, wenn das Konto wirklich entsteht - sonst verbraucht
	// ein abgebrochener Versuch ihn ersatzlos.
	if (!REGISTRATION_OPEN) {
		const code = String(body?.invite ?? "").trim();
		if (!gueltigerCode(locals.db, code)) error(403, "Einladungscode ungültig");
	}

	const userId = crypto.randomUUID();
	const options = await registrationOptions(displayName, userId);
	const challengeId = storeChallenge(locals.db, options.challenge, "register", userId);
	return json({ challengeId, userId, options });
};
