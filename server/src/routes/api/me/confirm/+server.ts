// Eine Bestaetigung anfordern - fuer eine Aktion, die sich nicht ruecknehmen laesst.
//
// Der Ablauf ist derselbe wie beim Anmelden, mit zwei Unterschieden:
//   - die Aufgabe ist an DIESES Konto gebunden, nicht an "irgendwer"
//   - der Authentifikator muss den Menschen pruefen (PIN, Fingerabdruck)
import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { confirmationOptions } from "$lib/server/webauthn";
import { storeChallenge } from "$lib/server/auth";
import { credentials } from "$lib/server/db/schema";
import { eq } from "drizzle-orm";

export const POST: RequestHandler = async ({ locals }) => {
	if (!locals.userId) error(401, "Nicht angemeldet");

	const eigene = locals.db
		.select()
		.from(credentials)
		.where(eq(credentials.userId, locals.userId))
		.all();
	// Ohne Passkey gibt es nichts zu bestaetigen. Das kann nur ein Konto sein, das
	// ueber ein Geraet gekoppelt wurde und nie einen eigenen angelegt hat - der
	// Aufrufer muss dann den Weg ueber das Geraete-Token gehen.
	if (eigene.length === 0) error(409, "Für dieses Konto ist kein Passkey hinterlegt");

	const options = await confirmationOptions(locals.db, locals.userId);
	const challengeId = storeChallenge(locals.db, options.challenge, "delete", locals.userId);
	return json({ challengeId, options });
};
