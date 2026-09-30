// Einen WEITEREN Passkey anlegen - für ein Konto, das es schon gibt.
import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { credentialDescriptors, listCredentials, registrationOptions } from "$lib/server/webauthn";
import { storeChallenge } from "$lib/server/auth";
import { requireUserRow } from "$lib/server/guards";

export const POST: RequestHandler = async ({ locals }) => {
	const user = requireUserRow(locals);

	const options = await registrationOptions(user.displayName, user.id);
	// Was schon da ist, ausschliessen. Sonst legt derselbe Authentifikator einen
	// zweiten Passkey für dasselbe Konto an - und der Mensch glaubt, er hätte
	// jetzt zwei Wege, obwohl beide an demselben Gerät hängen.
	options.excludeCredentials = credentialDescriptors(listCredentials(locals.db, user.id));

	const challengeId = storeChallenge(locals.db, options.challenge, "addkey", user.id);
	return json({ challengeId, options });
};
