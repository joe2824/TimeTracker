// Schritt 1 der Registrierung: Aufgabe stellen.
import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { registrationOptions } from "$lib/server/webauthn";
import { storeChallenge } from "$lib/server/auth";
import { INVITE_CODES, REGISTRATION_OPEN } from "$lib/server/config";
import { invites } from "$lib/server/db/schema";
import { and, eq, isNull } from "drizzle-orm";

export const POST: RequestHandler = async ({ locals, request }) => {
	const body = await request.json().catch(() => null);
	const displayName = String(body?.displayName ?? "").trim();
	if (!displayName || displayName.length > 64) error(400, "Anzeigename fehlt oder ist zu lang");

	// Geschlossener Betrieb: der Code wird hier nur GEPRUEFT, nicht entwertet.
	// Entwertet wird er erst, wenn das Konto wirklich entsteht - sonst verbraucht
	// ein abgebrochener Versuch ihn ersatzlos.
	if (!REGISTRATION_OPEN) {
		const code = String(body?.invite ?? "").trim();
		if (!bekannterCode(locals.db, code)) error(403, "Einladungscode ungültig");
	}

	const userId = crypto.randomUUID();
	const options = await registrationOptions(displayName, userId);
	const challengeId = storeChallenge(locals.db, options.challenge, "register", userId);
	return json({ challengeId, userId, options });
};

/**
 * Gilt der Code?
 *
 * Codes aus der Umgebung duerfen mehrfach benutzt werden - sie sind eine
 * Tuerklinke, kein Ticket. Codes in der Tabelle gelten genau einmal; so lassen
 * sich spaeter einzelne Einladungen vergeben, ohne den Container neu zu starten.
 */
function bekannterCode(db: App.Locals["db"], code: string): boolean {
	if (!code) return false;
	if (INVITE_CODES.includes(code)) return true;
	return (
		db
			.select()
			.from(invites)
			.where(and(eq(invites.code, code), isNull(invites.usedAt)))
			.get() !== undefined
	);
};
