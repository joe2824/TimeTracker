// Gekoppelte Geräte verwalten - vor allem: einzeln widerrufen.
import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { revokeDevice } from "$lib/server/auth";
import { readJson } from "$lib/server/request";
import { requireUser } from "$lib/server/guards";

/** Ein Gerät lösen. */
export const DELETE: RequestHandler = async ({ locals, request }) => {
	const userId = requireUser(locals);

	const body = await readJson(request);
	const requested = String(body?.deviceId ?? "");
	const deviceId = requested || locals.deviceId;

	// Kein Token, keine ID: dann ist das eine Browser-Sitzung, die sich selbst
	// lösen will - und die hat kein Gerät, sondern ein Cookie. Dafür ist
	// /api/auth/logout da.
	if (!deviceId) error(400, "Kein Gerät angegeben, und die Sitzung ist keines");

	if (!revokeDevice(locals.db, userId, deviceId)) {
		error(404, "Gerät unbekannt oder bereits widerrufen");
	}
	return json({ ok: true, deviceId });
};
