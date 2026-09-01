// Telemetrie-Endpunkt fuer anonyme Tages-Pings.
import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { timingSafeEqual } from "node:crypto";
import { TELEMETRY_KEY } from "$lib/server/config";
import { MAX_DEVICE_ID_LEN, MIN_DEVICE_ID_LEN, recordTelemetryPing } from "$lib/server/stats";

/**
 * Traegt der Aufrufer den richtigen Schluessel?
 *
 * Vergleich ohne Laufzeitunterschied. Die Laenge verraet der Vergleich
 * trotzdem - das ist hier kein Verlust, der Schluessel steht ohnehin in jedem
 * ausgelieferten Bundle.
 */
function keyMatches(given: string, expected: string): boolean {
	const a = Buffer.from(given);
	const b = Buffer.from(expected);
	if (a.length !== b.length) return false;
	return timingSafeEqual(a, b);
}

export const POST: RequestHandler = async ({ locals, request }) => {
	// Ohne konfigurierten Schluessel ist die Zaehlung aus. 404 und nicht 403: ein
	// abgeschalteter Endpunkt muss sich nicht als vorhanden zu erkennen geben.
	if (!TELEMETRY_KEY) error(404, "Nicht gefunden");
	if (!keyMatches(request.headers.get("x-telemetry-key") ?? "", TELEMETRY_KEY)) {
		error(401, "Nicht berechtigt");
	}

	const body = await request.json().catch(() => null);
	if (!body || typeof body !== "object") {
		error(400, "Ungültiger Inhalt");
	}

	const deviceId = typeof body.deviceId === "string" ? body.deviceId.trim() : "";
	const version = typeof body.version === "string" ? body.version.trim() : "";
	const platform = typeof body.platform === "string" ? body.platform.trim() : "";

	// Dieselbe Obergrenze wie beim Ablegen: eine laengere Kennung wuerde dort
	// gekuerzt, und zwei Geraete mit gleichem Anfang fielen zu einer Zeile
	// zusammen.
	if (deviceId.length < MIN_DEVICE_ID_LEN || deviceId.length > MAX_DEVICE_ID_LEN) {
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
