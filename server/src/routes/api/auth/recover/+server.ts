// Wiederherstellung mit der Phrase - der Weg fuer den Tag, an dem sonst nichts
// mehr da ist.
//
// Die Lage: der Rechner ist kaputt, ein zweites Geraet gibt es nicht, einen
// Passkey auch nicht. In der Hand sind 24 Woerter. Ohne diesen Endpunkt waere
// das eine Sackgasse - die Phrase oeffnet zwar die Verpackung, aber niemand
// kaeme an die Verpackung heran, denn dafuer muesste man angemeldet sein.
//
// ZWEI SCHRITTE, und der zweite ist der Grund, aus dem es sie beide gibt:
//
//   holen    - die Kennung sagt, WELCHES Konto gemeint ist. Der Server gibt die
//              Verpackung heraus. Sie ist Chiffrat; wer die Woerter nicht hat,
//              haelt Bytes in der Hand.
//
//   anmelden - der Client hat die Verpackung geoeffnet und beweist es mit einem
//              Wert, den nur der Tresorschluessel ergibt. Erst dann gibt es ein
//              Geraete-Token.
//
// Ohne den zweiten Schritt genuegte die Kennung. Wer sie aus einer gestohlenen
// Datenbank abliest, bekaeme ein Token, damit Zugriff auf alle Chiffrate und die
// Moeglichkeit, sie zu loeschen - ohne je etwas entschluesselt zu haben. Die
// Daten blieben zwar unlesbar, aber weg waeren sie trotzdem.
import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { keyWraps, users } from "$lib/server/db/schema";
import { and, eq } from "drizzle-orm";
import { createDevice, safeEqual } from "$lib/server/auth";

export const POST: RequestHandler = async ({ locals, request }) => {
	const body = await request.json().catch(() => null);
	const recoveryId = String(body?.recoveryId ?? "");
	if (!recoveryId) error(400, "Kennung fehlt");

	const user = locals.db.select().from(users).where(eq(users.recoveryId, recoveryId)).get();
	// Absichtlich dieselbe Meldung fuer "gibt es nicht" und "hat keine
	// Verpackung": sonst laesst sich herausfinden, welche Konten es gibt.
	const wrap = user
		? locals.db
				.select()
				.from(keyWraps)
				.where(and(eq(keyWraps.userId, user.id), eq(keyWraps.kind, "recovery")))
				.get()
		: undefined;
	if (!user || !wrap) error(404, "Zu dieser Phrase gibt es kein Konto");

	const proof = body?.proof ? String(body.proof) : null;

	// Schritt 1: nur die Verpackung. Sie oeffnet sich nur mit den Woertern.
	if (!proof) return json({ wrap: wrap.payload });

	// Schritt 2: der Nachweis. Ohne hinterlegten Vergleichswert stammt das Konto
	// aus einer Zeit vor diesem Weg - dann gibt es ihn hier nicht, und der Mensch
	// muss ueber ein anderes Geraet koppeln.
	if (!user.vaultProof) error(409, "Für dieses Konto ist dieser Weg nicht eingerichtet");
	if (!safeEqual(proof, user.vaultProof)) error(401, "Nachweis stimmt nicht");

	const label = String(body?.label ?? "Wiederhergestelltes Gerät").trim().slice(0, 64);
	const geraet = createDevice(locals.db, user.id, label);

	return json({
		userId: user.id,
		displayName: user.displayName,
		deviceId: geraet.id,
		deviceToken: geraet.token
	});
};
