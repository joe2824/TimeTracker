// Kopplung, Schritt 2 - auf dem BEREITS ENTSPERRTEN Gerät.
import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { pairings } from "$lib/server/db/schema";
import { eq } from "drizzle-orm";
import { createDevice } from "$lib/server/auth";
import { MAX_RECORD_BYTES } from "$lib/server/config";
import { normalizePairingCode, openPairing } from "$lib/server/pairing";
import { readJson } from "$lib/server/request";
import { requireUser } from "$lib/server/guards";

export const GET: RequestHandler = ({ locals, url }) => {
	requireUser(locals);
	const row = openPairing(locals.db, normalizePairingCode(url.searchParams.get("code")));
	if (!row) error(404, "Code unbekannt oder abgelaufen");
	// Nur was zum Verpacken gebraucht wird.
	return json({ publicKey: row.publicKey, label: row.label });
};

export const POST: RequestHandler = async ({ locals, request }) => {
	const userId = requireUser(locals);
	const body = await readJson(request);
	const code = normalizePairingCode(body?.code);
	const wrappedKey = String(body?.wrappedKey ?? "");
	if (!wrappedKey || wrappedKey.length > MAX_RECORD_BYTES) {
		error(400, "Paket fehlt oder ist zu groß");
	}

	const row = openPairing(locals.db, code);
	if (!row) error(404, "Code unbekannt oder abgelaufen");
	if (row.wrappedKey) error(409, "Dieser Code wurde bereits bestätigt");

	// Das Geräte-Token entsteht hier und wird gleich mit hinterlegt: das neue
	// Gerät holt beides in einem Zug ab.
	const device = createDevice(locals.db, userId, row.label);
	locals.db
		.update(pairings)
		.set({ userId, wrappedKey, deviceToken: device.token })
		.where(eq(pairings.code, code))
		.run();

	return json({ deviceId: device.id, label: row.label });
};
