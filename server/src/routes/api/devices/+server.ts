// Gekoppelte Geraete verwalten - vor allem: einzeln widerrufen.
import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { revokeDevice } from "$lib/server/auth";

/**
 * Ein Geraet loesen.
 *
 * Ohne `deviceId` loest sich das aufrufende Geraet selbst - der Weg, den das
 * Entkoppeln geht. Das Geraet kennt seine eigene Kennung beim Server naemlich
 * nicht: bei der Kopplung bekommt es ein Token, keine ID. Es muesste sie also
 * erst ueber /api/me suchen und dort erraten, welche der aufgefuehrten Zeilen es
 * selbst ist. Der Server weiss das ohnehin - er hat gerade das Token geprueft.
 *
 * Mit `deviceId` loest ein Geraet ein ANDERES: der Fall "Handy verloren".
 */
export const DELETE: RequestHandler = async ({ locals, request }) => {
	if (!locals.userId) error(401, "Nicht angemeldet");

	const body = await request.json().catch(() => null);
	const gewuenscht = String(body?.deviceId ?? "");
	const deviceId = gewuenscht || locals.deviceId;

	// Kein Token, keine ID: dann ist das eine Browser-Sitzung, die sich selbst
	// loesen will - und die hat kein Geraet, sondern ein Cookie. Dafuer ist
	// /api/auth/logout da.
	if (!deviceId) error(400, "Kein Gerät angegeben, und die Sitzung ist keines");

	if (!revokeDevice(locals.db, locals.userId, deviceId)) {
		error(404, "Gerät unbekannt oder bereits widerrufen");
	}
	return json({ ok: true, deviceId });
};
