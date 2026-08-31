// Ein Konto von einem GERAET aus anlegen - ohne Passkey.
import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { consumeCode, validCode, isRegistrationOpen } from "$lib/server/invites";
import { createDevice } from "$lib/server/auth";
import { createUser } from "$lib/server/webauthn";

export const POST: RequestHandler = async ({ locals, request }) => {
	const body = await request.json().catch(() => null);

	const label = String(body?.label ?? "Dieser Rechner").trim().slice(0, 64);
	const userId = crypto.randomUUID();

	// Ein Name ist NICHT noetig.
	const requested = String(body?.displayName ?? "").trim();
	if (requested.length > 64) error(400, "Anzeigename ist zu lang");
	const displayName = requested || userId;
	const code = String(body?.invite ?? "").trim();
	if (!isRegistrationOpen(locals.db) && !validCode(locals.db, code)) {
		error(403, "Einladungscode ungültig");
	}

	const email = body?.email ? String(body.email).trim().toLowerCase() : null;

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
