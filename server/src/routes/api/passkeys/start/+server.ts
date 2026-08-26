// Einen WEITEREN Passkey anlegen - fuer ein Konto, das es schon gibt.
//
// Nicht zu verwechseln mit /api/auth/register: das legt ein Konto AN. Hier ist
// eines vorhanden, jemand ist angemeldet, und es kommt ein zweiter Weg hinein
// dazu.
//
// Wofuer: der Rechner wird getauscht, das Handy geht verloren, der Passkey liegt
// auf einem Stick, den man verlegt. Ein Konto mit genau einem Passkey haengt an
// genau einem Gegenstand - und die Wiederherstellungs-Phrase ist der Weg, den
// man genau dann nicht zur Hand hat.
import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { registrationOptions } from "$lib/server/webauthn";
import { storeChallenge } from "$lib/server/auth";
import { credentials, users } from "$lib/server/db/schema";
import { eq } from "drizzle-orm";

export const POST: RequestHandler = async ({ locals }) => {
	if (!locals.userId) error(401, "Nicht angemeldet");
	const user = locals.db.select().from(users).where(eq(users.id, locals.userId)).get();
	if (!user) error(401, "Nicht angemeldet");

	const vorhandene = locals.db
		.select()
		.from(credentials)
		.where(eq(credentials.userId, user.id))
		.all();

	const options = await registrationOptions(user.displayName, user.id);
	// Was schon da ist, ausschliessen. Sonst legt derselbe Authentifikator einen
	// zweiten Passkey fuer dasselbe Konto an - und der Mensch glaubt, er haette
	// jetzt zwei Wege, obwohl beide an demselben Geraet haengen.
	options.excludeCredentials = vorhandene.map((c) => ({
		type: "public-key" as const,
		id: c.id,
		transports: c.transports ? JSON.parse(c.transports) : undefined
	}));

	const challengeId = storeChallenge(locals.db, options.challenge, "addkey", user.id);
	return json({ challengeId, options });
};
