// Den weiteren Passkey uebernehmen.
import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { storeCredential, verifyRegistration } from "$lib/server/webauthn";
import { takeChallenge } from "$lib/server/auth";
import { credentials } from "$lib/server/db/schema";
import { and, eq } from "drizzle-orm";

export const POST: RequestHandler = async ({ locals, request }) => {
	if (!locals.userId) error(401, "Nicht angemeldet");
	const body = await request.json().catch(() => null);

	const task = takeChallenge(locals.db, String(body?.challengeId ?? ""), "addkey");
	if (!task) error(400, "Aufgabe abgelaufen – bitte erneut versuchen");
	// Die Aufgabe wurde fuer DIESES Konto ausgegeben. Ohne diese Zeile liesse sich
	// eine anderswo abgeholte Aufgabe hier einloesen und ein fremder Passkey an
	// ein fremdes Konto haengen.
	if (task.userId !== locals.userId) error(403, "Aufgabe gehört zu einem anderen Konto");

	const checked = await verifyRegistration(body?.response, task.challenge);
	if (!checked.verified || !checked.registrationInfo) {
		error(400, "Passkey konnte nicht bestätigt werden");
	}

	const hostId = checked.registrationInfo.credential.id;
	const already = locals.db.select().from(credentials).where(eq(credentials.id, hostId)).get();
	if (already) {
		// Kann trotz excludeCredentials passieren, wenn ein Authentifikator es
		// ignoriert. Zwei Zeilen fuer denselben Schluessel waeren ein Konto, das
		// sich selbst nicht mehr erklaeren kann.
		error(409, "Dieser Passkey ist bereits hinterlegt");
	}

	const label = String(body?.label ?? "").trim().slice(0, 64) || null;
	storeCredential(
		locals.db,
		locals.userId,
		checked.registrationInfo.credential,
		checked.registrationInfo.credential.transports,
		label
	);

	return json({ id: hostId, label });
};
