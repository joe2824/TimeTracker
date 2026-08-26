// Kopplung, Schritt 3 - wieder auf dem NEUEN Geraet.
//
// Es fragt seinen eigenen Code ab und bekommt das Paket samt Geraete-Token,
// sobald jemand bestaetigt hat. Danach ist der Vorgang weg: ein liegen
// gebliebenes Paket waere ein Angriffsziel ohne jeden Nutzen.
import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { pairings } from "$lib/server/db/schema";
import { eq } from "drizzle-orm";
import { normalisiereCode } from "$lib/server/pairing";

export const POST: RequestHandler = async ({ locals, request }) => {
	const body = await request.json().catch(() => null);
	const code = normalisiereCode(body?.code);

	const row = locals.db.select().from(pairings).where(eq(pairings.code, code)).get();
	if (!row || row.expiresAt < Date.now()) error(404, "Code unbekannt oder abgelaufen");
	// Noch nicht bestaetigt: kein Fehler, sondern "warte weiter".
	if (!row.wrappedKey || !row.deviceToken || !row.userId) return json({ pending: true });

	locals.db.delete(pairings).where(eq(pairings.code, code)).run();
	return json({
		pending: false,
		userId: row.userId,
		wrappedKey: row.wrappedKey,
		deviceToken: row.deviceToken
	});
};
