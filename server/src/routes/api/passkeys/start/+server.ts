// Einen WEITEREN Passkey anlegen - fuer ein Konto, das es schon gibt.
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

	const existing = locals.db
		.select()
		.from(credentials)
		.where(eq(credentials.userId, user.id))
		.all();

	const options = await registrationOptions(user.displayName, user.id);
	// Was schon da ist, ausschliessen. Sonst legt derselbe Authentifikator einen
	// zweiten Passkey fuer dasselbe Konto an - und der Mensch glaubt, er haette
	// jetzt zwei Wege, obwohl beide an demselben Geraet haengen.
	options.excludeCredentials = existing.map((c) => ({
		type: "public-key" as const,
		id: c.id,
		transports: c.transports ? JSON.parse(c.transports) : undefined
	}));

	const challengeId = storeChallenge(locals.db, options.challenge, "addkey", user.id);
	return json({ challengeId, options });
};
