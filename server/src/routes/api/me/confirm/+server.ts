// Eine Bestätigung anfordern - für eine Aktion, die sich nicht rücknehmen lässt.
//
// Der Ablauf ist derselbe wie beim Anmelden, mit zwei Unterschieden:
//   - die Aufgabe ist an DIESES Konto gebunden, nicht an "irgendwer"
//   - der Authentifikator muss den Menschen prüfen (PIN, Fingerabdruck)
import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { confirmationOptions, listCredentials } from "$lib/server/webauthn";
import { storeChallenge } from "$lib/server/auth";
import { requireUser } from "$lib/server/guards";

export const POST: RequestHandler = async ({ locals }) => {
	const userId = requireUser(locals);

	const own = listCredentials(locals.db, userId);
	// Ohne Passkey gibt es nichts zu bestätigen. Das kann nur ein Konto sein, das
	// über ein Gerät gekoppelt wurde und nie einen eigenen angelegt hat - der
	// Aufrufer muss dann den Weg über das Geräte-Token gehen.
	if (own.length === 0) error(409, "Für dieses Konto ist kein Passkey hinterlegt");

	const options = await confirmationOptions(locals.db, userId);
	const challengeId = storeChallenge(locals.db, options.challenge, "delete", userId);
	return json({ challengeId, options });
};
