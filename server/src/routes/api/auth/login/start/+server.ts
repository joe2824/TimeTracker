import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { authenticationOptions } from "$lib/server/webauthn";
import { storeChallenge } from "$lib/server/auth";

export const POST: RequestHandler = async ({ locals }) => {
	const options = await authenticationOptions();
	const challengeId = storeChallenge(locals.db, options.challenge, "login", null);
	return json({ challengeId, options });
};
