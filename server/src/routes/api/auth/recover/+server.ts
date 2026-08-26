// Wiederherstellung mit der Phrase: Konto zurueckholen, wenn weder ein zweites
// Geraet noch ein Passkey da ist.
import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { keyWraps, users } from "$lib/server/db/schema";
import { and, desc, eq } from "drizzle-orm";
import { createDevice, hashSecret, safeEqual } from "$lib/server/auth";

export const POST: RequestHandler = async ({ locals, request }) => {
	const body = await request.json().catch(() => null);
	const recoveryId = String(body?.recoveryId ?? "");
	if (!recoveryId) error(400, "Kennung fehlt");

	const user = locals.db.select().from(users).where(eq(users.recoveryId, recoveryId)).get();
	// Die juengste, falls je mehr als eine dastehen sollte.
	const wrap = user
		? locals.db
				.select()
				.from(keyWraps)
				.where(and(eq(keyWraps.userId, user.id), eq(keyWraps.kind, "recovery")))
				.orderBy(desc(keyWraps.createdAt))
				.get()
		: undefined;
	// Absichtlich dieselbe Meldung fuer "gibt es nicht" und "hat keine
	// Verpackung": sonst laesst sich herausfinden, welche Konten es gibt.
	if (!user || !wrap) error(404, "Zu dieser Phrase gibt es kein Konto");

	const proof = body?.proof ? String(body.proof) : null;

	// Schritt 1: nur die Verpackung. Sie oeffnet sich nur mit den Woertern.
	if (!proof) return json({ wrap: wrap.payload });

	// Schritt 2: der Nachweis - gegen den Hash, nicht gegen den Wert.
	if (!user.vaultProof || !safeEqual(hashSecret(proof), user.vaultProof)) {
		error(401, "Nachweis stimmt nicht");
	}

	const label = String(body?.label ?? "Wiederhergestelltes Gerät").trim().slice(0, 64);
	const geraet = createDevice(locals.db, user.id, label);

	return json({
		userId: user.id,
		displayName: user.displayName,
		deviceId: geraet.id,
		deviceToken: geraet.token
	});
};
