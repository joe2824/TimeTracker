// Oeffentlicher Telemetrie-Endpunkt fuer anonyme Tages-Pings.
import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { recordTelemetryPing } from "$lib/server/stats";

export const POST: RequestHandler = async ({ locals, request }) => {
	const body = await request.json().catch(() => null);
	if (!body || typeof body !== "object") {
		error(400, "Ungültiger Inhalt");
	}

	const deviceId = typeof body.deviceId === "string" ? body.deviceId.trim() : "";
	const version = typeof body.version === "string" ? body.version.trim() : "unbekannt";
	const platform = typeof body.platform === "string" ? body.platform.trim() : "unbekannt";

	if (!deviceId || deviceId.length < 4 || deviceId.length > 128) {
		error(400, "Ungültige Gerätekennung");
	}

	const result = recordTelemetryPing(locals.db, {
		deviceId,
		version,
		platform
	});

	if (!result.ok) {
		error(400, "Ping konnte nicht erfasst werden");
	}

	return json({ ok: true });
};

