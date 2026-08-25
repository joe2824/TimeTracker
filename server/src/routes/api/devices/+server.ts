// Gekoppelte Geraete verwalten - vor allem: einzeln widerrufen.
import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { revokeDevice } from "$lib/server/auth";

export const DELETE: RequestHandler = async ({ locals, request }) => {
	if (!locals.userId) error(401, "Nicht angemeldet");
	const body = await request.json().catch(() => null);
	const deviceId = String(body?.deviceId ?? "");
	if (!revokeDevice(locals.db, locals.userId, deviceId)) {
		error(404, "Gerät unbekannt oder bereits widerrufen");
	}
	return json({ ok: true });
};
