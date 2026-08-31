// Kopplung, Schritt 1 - auf dem NEUEN Geraet.
import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { pairings } from "$lib/server/db/schema";
import { PAIRING_TTL_MS } from "$lib/server/config";
import { eq } from "drizzle-orm";
import { safeEqual } from "$lib/server/auth";
import { isPairingCode, isClaimHash, normalizeCode } from "$lib/server/pairing";

/**
 * Der Code kommt vom Geraet, nicht von hier - er ist der Abdruck des oeffentlichen
 * Schluessels. Nachgerechnet wird auf den GERAETEN, nie hier.
 *
 * Dazu kommt der Hash eines Abhol-Geheimnisses. Das Geheimnis selbst bleibt auf
 * dem Geraet: der Code muss sichtbar sein, damit ein Mensch ihn vergleichen kann,
 * und taugt deshalb nicht als Ausweis beim Abholen.
 */
export const POST: RequestHandler = async ({ locals, request }) => {
	const body = await request.json().catch(() => null);
	const publicKey = String(body?.publicKey ?? "");
	const label = String(body?.label ?? "Neues Gerät").slice(0, 64);
	const code = normalizeCode(body?.code);
	const claimHash = String(body?.claimHash ?? "");
	if (!publicKey || publicKey.length > 512) error(400, "Öffentlicher Schlüssel fehlt");
	if (!isPairingCode(code)) error(400, "Kopplungscode hat nicht die erwartete Form");
	if (!isClaimHash(claimHash)) {
		// Aeltere Fassungen der Anwendung schicken ihn nicht mit. Ohne ihn liesse
		// sich das Geraete-Token allein mit dem Code abholen - genau das soll nicht
		// mehr gehen, also wird der Vorgang abgewiesen statt still geschwaecht.
		error(400, "Diese Version koppelt nicht mehr mit; bitte die Anwendung aktualisieren.");
	}

	const expiresAt = Date.now() + PAIRING_TTL_MS;
	const present = locals.db.select().from(pairings).where(eq(pairings.code, code)).get();

	// Derselbe Schluessel ergibt denselben Code - ein zweiter Aufruf desselben
	// Geraets landet also zwangslaeufig hier. Das ist ein erneuter Versuch und
	// bekommt bloss frische Zeit; ein laufender Vorgang wird dabei NICHT
	// weggeraeumt, damit ein schon hinterlegtes Paket nicht verlorengeht.
	if (present && present.expiresAt >= Date.now()) {
		if (present.publicKey !== publicKey) {
			// Ein anderer Schluessel unter demselben Code. Bei zwoelf Stellen ist das
			// kein Zufall - und ein unangemeldeter Aufruf darf einem laufenden
			// Vorgang nicht dazwischenfahren.
			error(409, "Unter diesem Code läuft bereits eine andere Kopplung");
		}
		// Dasselbe gilt fuer das Abhol-Geheimnis: wer den Code UND den oeffentlichen
		// Schluessel kennt (beides ist sichtbar bzw. abfragbar), duerfte sonst ein
		// eigenes Geheimnis nachschieben und dem echten Geraet das Token wegnehmen.
		if (present.claimHash && !safeEqual(present.claimHash, claimHash)) {
			error(409, "Unter diesem Code läuft bereits eine andere Kopplung");
		}
		locals.db
			.update(pairings)
			.set({ label, expiresAt, claimHash })
			.where(eq(pairings.code, code))
			.run();
		return json({ code, expiresAt });
	}

	// Was abgelaufen ist, darf weichen.
	if (present) locals.db.delete(pairings).where(eq(pairings.code, code)).run();

	// Der Vorgang haengt noch an keinem Konto: welches es wird, entscheidet sich
	// erst, wenn ein entsperrtes Geraet ihn bestaetigt.
	locals.db
		.insert(pairings)
		.values({ code, userId: null, publicKey, label, claimHash, createdAt: Date.now(), expiresAt })
		.run();
	return json({ code, expiresAt });
};
