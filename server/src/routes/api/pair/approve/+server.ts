// Kopplung, Schritt 2 - auf dem BEREITS ENTSPERRTEN Geraet.
import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { pairings } from "$lib/server/db/schema";
import { eq } from "drizzle-orm";
import { createDevice } from "$lib/server/auth";
import { MAX_RECORD_BYTES } from "$lib/server/config";
import type { Db } from "$lib/server/db";
import { normalizePairingCode } from "$lib/server/pairing";

/** Den offenen Vorgang zu einem Code holen - oder nichts. */
function openPairing(db: Db, code: string) {
	const row = db.select().from(pairings).where(eq(pairings.code, code)).get();
	if (!row || row.expiresAt < Date.now()) return null;
	return row;
}

export const GET: RequestHandler = ({ locals, url }) => {
	if (!locals.userId) error(401, "Nicht angemeldet");
	const row = openPairing(locals.db, normalizePairingCode(url.searchParams.get("code")));
	if (!row) error(404, "Code unbekannt oder abgelaufen");
	// Nur was zum Verpacken gebraucht wird.
	return json({ publicKey: row.publicKey, label: row.label });
};

export const POST: RequestHandler = async ({ locals, request }) => {
	if (!locals.userId) error(401, "Nicht angemeldet");
	const body = await request.json().catch(() => null);
	const code = normalizePairingCode(body?.code);
	const wrappedKey = String(body?.wrappedKey ?? "");
	if (!wrappedKey || wrappedKey.length > MAX_RECORD_BYTES) {
		error(400, "Paket fehlt oder ist zu groß");
	}

	const row = openPairing(locals.db, code);
	if (!row) error(404, "Code unbekannt oder abgelaufen");
	if (row.wrappedKey) error(409, "Dieser Code wurde bereits bestätigt");

	// Das Geraete-Token entsteht hier und wird gleich mit hinterlegt: das neue
	// Geraet holt beides in einem Zug ab.
	const device = createDevice(locals.db, locals.userId, row.label);
	locals.db
		.update(pairings)
		.set({ userId: locals.userId, wrappedKey, deviceToken: device.token })
		.where(eq(pairings.code, code))
		.run();

	return json({ deviceId: device.id, label: row.label });
};
