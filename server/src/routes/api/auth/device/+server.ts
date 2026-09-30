// Ein Konto von einem GERAET aus anlegen - ohne Passkey.
import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { readRegistrationFields, redeemInviteCode } from "$lib/server/registration";
import { readJson } from "$lib/server/request";
import { LABEL_MAX, readLabel } from "$shared/labels";
import { createDevice } from "$lib/server/auth";
import { createUser } from "$lib/server/webauthn";

export const POST: RequestHandler = async ({ locals, request }) => {
	const body = await readJson(request);

	const label = readLabel(body?.label, "Dieser Rechner", LABEL_MAX);
	const userId = crypto.randomUUID();

	// Ein Name ist NICHT nötig.
	const { displayName, code, email } = readRegistrationFields(locals.db, body, userId);

	// Konto und Gerät gehören zusammen: entweder entsteht beides, oder nichts.
	// Ein Konto ohne Gerät wäre unerreichbar - es gibt ja keinen Passkey, mit
	// dem man sich stattdessen anmelden könnte.
	const deviceRow = locals.db.transaction((tx) => {
		createUser(tx, userId, displayName, email);
		redeemInviteCode(tx, code, userId);
		return createDevice(tx, userId, label);
	});

	return json({
		userId,
		displayName,
		deviceId: deviceRow.id,
		// Genau einmal. Danach steht nur noch der Hash in der Datenbank.
		deviceToken: deviceRow.token
	});
};
