// Den weiteren Passkey übernehmen.
import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { storeCredential, verifyRegistration } from "$lib/server/webauthn";
import { takeChallenge } from "$lib/server/auth";
import { credentials } from "$lib/server/db/schema";
import { eq } from "drizzle-orm";
import { readJson } from "$lib/server/request";
import { requireUser } from "$lib/server/guards";
import { LABEL_MAX, readLabel } from "$shared/labels";

export const POST: RequestHandler = async ({ locals, request }) => {
	const userId = requireUser(locals);
	const body = await readJson(request);

	const task = takeChallenge(locals.db, String(body?.challengeId ?? ""), "addkey");
	if (!task) error(400, "Aufgabe abgelaufen – bitte erneut versuchen");
	// Die Aufgabe wurde für DIESES Konto ausgegeben. Ohne diese Zeile liesse sich
	// eine anderswo abgeholte Aufgabe hier einlösen und ein fremder Passkey an
	// ein fremdes Konto hängen.
	if (task.userId !== userId) error(403, "Aufgabe gehört zu einem anderen Konto");

	const checked = await verifyRegistration(body?.response, task.challenge);
	if (!checked.verified || !checked.registrationInfo) {
		error(400, "Passkey konnte nicht bestätigt werden");
	}

	const hostId = checked.registrationInfo.credential.id;
	const already = locals.db.select().from(credentials).where(eq(credentials.id, hostId)).get();
	if (already) {
		// Kann trotz excludeCredentials passieren, wenn ein Authentifikator es
		// ignoriert. Zwei Zeilen für denselben Schlüssel wären ein Konto, das
		// sich selbst nicht mehr erklären kann.
		error(409, "Dieser Passkey ist bereits hinterlegt");
	}

	const label = readLabel(body?.label, null, LABEL_MAX);
	storeCredential(
		locals.db,
		userId,
		checked.registrationInfo.credential,
		checked.registrationInfo.credential.transports,
		label
	);

	return json({ id: hostId, label });
};
