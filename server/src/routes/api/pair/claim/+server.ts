// Kopplung, Schritt 3 - wieder auf dem NEUEN Geraet.
import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { pairings } from "$lib/server/db/schema";
import { eq } from "drizzle-orm";
import { safeEqual, sha256Hex } from "$lib/server/auth";
import { normalisiereCode } from "$lib/server/pairing";

/**
 * Abgeholt wird mit Code UND Abhol-Geheimnis.
 *
 * Der Code allein reicht bewusst nicht: er ist der Abdruck des Geraeteschluessels
 * und steht zum Vergleichen auf dem Bildschirm. Wer ihn mitliest, bekaeme sonst
 * das Geraete-Token - zwar nicht den Tresorschluessel, aber Zugang zu den
 * versiegelten Datensaetzen, und der echte Vorgang waere abgeraeumt.
 *
 * Ein falsches Geheimnis antwortet wie ein unbekannter Code: 404. Sonst verriete
 * die Antwort, dass es diesen Vorgang gibt - und die Bremse in hooks.server.ts
 * zaehlt genau diese 404 als Fehlgriff.
 */
export const POST: RequestHandler = async ({ locals, request }) => {
	const body = await request.json().catch(() => null);
	const code = normalisiereCode(body?.code);
	const claimSecret = String(body?.claimSecret ?? "");

	const row = locals.db.select().from(pairings).where(eq(pairings.code, code)).get();
	if (!row || row.expiresAt < Date.now()) error(404, "Code unbekannt oder abgelaufen");
	if (!row.claimHash || !claimSecret || !safeEqual(row.claimHash, sha256Hex(claimSecret))) {
		error(404, "Code unbekannt oder abgelaufen");
	}
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
