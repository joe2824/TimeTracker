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
	// Zwei Wege herein:
	//
	// - Eine angemeldete Sitzung bzw. ein verknuepftes Geraet. Das ist der
	//   Regelfall und braucht keine Konfiguration: wer hier angemeldet ist, ist
	//   ein echter Nutzer dieses Servers.
	// - Der Schluessel aus dem Build. Nur so zaehlt eine Installation, die noch
	//   gar kein Konto hat - sie hat sonst nichts, womit sie sich ausweisen kann.
	const givenKey = request.headers.get("x-telemetry-key");
	const withKey = TELEMETRY_KEY && givenKey ? keyMatches(givenKey, TELEMETRY_KEY) : false;
	if (!withKey && !locals.userId) {
		// Der Unterschied entscheidet, ob der Client es nochmal versucht: 403 heisst
		// fuer ihn "hier nie wieder fragen", 401 nur "gerade nicht". Ein Schluessel,
		// den dieser Server nicht annimmt, wird auch morgen keiner sein - eine
		// fehlende Anmeldung kann dagegen jederzeit dazukommen.
		if (givenKey) error(403, "Nicht berechtigt");
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
