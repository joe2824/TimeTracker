// Kopplung, Schritt 1 - auf dem NEUEN Geraet.
import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { pairings } from "$lib/server/db/schema";
import { PAIRING_TTL_MS } from "$lib/server/config";
import { eq } from "drizzle-orm";
import { istPairingCode, normalisiereCode } from "$lib/server/pairing";

/**
 * Der Code kommt vom Geraet, nicht von hier - er ist der Abdruck des oeffentlichen
 * Schluessels. Nachgerechnet wird auf den GERAETEN, nie hier.
 */
export const POST: RequestHandler = async ({ locals, request }) => {
	const body = await request.json().catch(() => null);
	const publicKey = String(body?.publicKey ?? "");
	const label = String(body?.label ?? "Neues Gerät").slice(0, 64);
	const code = normalisiereCode(body?.code);
	if (!publicKey || publicKey.length > 512) error(400, "Öffentlicher Schlüssel fehlt");
	if (!istPairingCode(code)) error(400, "Kopplungscode hat nicht die erwartete Form");

	const expiresAt = Date.now() + PAIRING_TTL_MS;
	const vorhanden = locals.db.select().from(pairings).where(eq(pairings.code, code)).get();

	// Derselbe Schluessel ergibt denselben Code - ein zweiter Aufruf desselben
	// Geraets landet also zwangslaeufig hier. Das ist ein erneuter Versuch und
	// bekommt bloss frische Zeit; ein laufender Vorgang wird dabei NICHT
	// weggeraeumt, damit ein schon hinterlegtes Paket nicht verlorengeht.
	if (vorhanden && vorhanden.expiresAt >= Date.now()) {
		if (vorhanden.publicKey !== publicKey) {
			// Ein anderer Schluessel unter demselben Code. Bei zwoelf Stellen ist das
			// kein Zufall - und ein unangemeldeter Aufruf darf einem laufenden
			// Vorgang nicht dazwischenfahren.
			error(409, "Unter diesem Code läuft bereits eine andere Kopplung");
		}
		locals.db.update(pairings).set({ label, expiresAt }).where(eq(pairings.code, code)).run();
		return json({ code, expiresAt });
	}

	// Was abgelaufen ist, darf weichen.
	if (vorhanden) locals.db.delete(pairings).where(eq(pairings.code, code)).run();

	// Der Vorgang haengt noch an keinem Konto: welches es wird, entscheidet sich
	// erst, wenn ein entsperrtes Geraet ihn bestaetigt.
	locals.db
		.insert(pairings)
		.values({ code, userId: null, publicKey, label, createdAt: Date.now(), expiresAt })
		.run();
	return json({ code, expiresAt });
};
