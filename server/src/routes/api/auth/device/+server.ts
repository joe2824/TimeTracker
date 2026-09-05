// Ein Konto von einem GERAET aus anlegen - ohne Passkey.
import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { consumeCode, isRegistrationOpen } from "$lib/server/invites";
import { readRegistrationFields } from "$lib/server/registration";
import { createDevice } from "$lib/server/auth";
import { createUser } from "$lib/server/webauthn";

export const POST: RequestHandler = async ({ locals, request }) => {
	const body = await request.json().catch(() => null);

	const label = String(body?.label ?? "Dieser Rechner").trim().slice(0, 64);
	const userId = crypto.randomUUID();

	// Ein Name ist NICHT noetig.
	const { displayName, code, email } = readRegistrationFields(locals.db, body, userId);

	// Konto und Geraet gehoeren zusammen: entweder entsteht beides, oder nichts.
	// Ein Konto ohne Geraet waere unerreichbar - es gibt ja keinen Passkey, mit
	// dem man sich stattdessen anmelden koennte.
	const deviceRow = locals.db.transaction((tx) => {
		createUser(tx, userId, displayName, email);
		if (!isRegistrationOpen(locals.db) && code) consumeCode(tx, code, userId);
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
