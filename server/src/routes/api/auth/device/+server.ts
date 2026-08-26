// Ein Konto von einem GERAET aus anlegen - ohne Passkey.
import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { REGISTRATION_OPEN } from "$lib/server/config";
import { entwerteCode, gueltigerCode } from "$lib/server/invites";
import { createDevice } from "$lib/server/auth";
import { createUser } from "$lib/server/webauthn";

export const POST: RequestHandler = async ({ locals, request }) => {
	const body = await request.json().catch(() => null);

	const label = String(body?.label ?? "Dieser Rechner").trim().slice(0, 64);
	const userId = crypto.randomUUID();

	// Ein Name ist NICHT noetig.
	const gewuenscht = String(body?.displayName ?? "").trim();
	if (gewuenscht.length > 64) error(400, "Anzeigename ist zu lang");
	const displayName = gewuenscht || userId;
	const code = String(body?.invite ?? "").trim();
	if (!REGISTRATION_OPEN && !gueltigerCode(locals.db, code)) {
		error(403, "Einladungscode ungültig");
	}

	const email = body?.email ? String(body.email).trim().toLowerCase() : null;

	// Konto und Geraet gehoeren zusammen: entweder entsteht beides, oder nichts.
	// Ein Konto ohne Geraet waere unerreichbar - es gibt ja keinen Passkey, mit
	// dem man sich stattdessen anmelden koennte.
	const geraet = locals.db.transaction((tx) => {
		createUser(tx, userId, displayName, email);
		if (!REGISTRATION_OPEN) entwerteCode(tx, code, userId);
		return createDevice(tx, userId, label);
	});

	return json({
		userId,
		displayName,
		deviceId: geraet.id,
		// Genau einmal. Danach steht nur noch der Hash in der Datenbank.
		deviceToken: geraet.token
	});
};
