// Die verpackten Tresorschluessel.
import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { keyWraps, users } from "$lib/server/db/schema";
import { and, eq } from "drizzle-orm";
import { MAX_RECORD_BYTES } from "$lib/server/config";
import { hashSecret } from "$lib/server/auth";

export const GET: RequestHandler = ({ locals }) => {
	if (!locals.userId) error(401, "Nicht angemeldet");
	return json({
		wraps: locals.db
			.select()
			.from(keyWraps)
			.where(eq(keyWraps.userId, locals.userId))
			.all()
			.map((w) => ({ id: w.id, kind: w.kind, credentialId: w.credentialId, payload: w.payload }))
	});
};

export const POST: RequestHandler = async ({ locals, request }) => {
	if (!locals.userId) error(401, "Nicht angemeldet");
	const userId = locals.userId;
	const body = await request.json().catch(() => null);
	const kind = String(body?.kind ?? "");
	const payload = String(body?.payload ?? "");
	if (!["recovery", "passkey", "device"].includes(kind)) error(400, "Unbekannte Art");
	if (!payload || payload.length > MAX_RECORD_BYTES) {
		error(400, "Verpackung fehlt oder ist zu groß");
	}

	const credentialId = body?.credentialId ? String(body.credentialId) : null;
	const recoveryId = body?.recoveryId ? String(body.recoveryId) : null;
	const vaultProof = body?.vaultProof ? String(body.vaultProof) : null;

	// Beides oder keins: eines allein wuerde das andere ueberschreiben, und ein
	// Konto mit nur einem der beiden ist ueber die Phrase nicht mehr erreichbar.
	if (kind === "recovery" && Boolean(recoveryId) !== Boolean(vaultProof)) {
		error(400, "Kennung und Nachweis gehören zusammen");
	}

	const id = crypto.randomUUID();

	// Alles in EINER Transaktion: bei "recovery" haengen drei Schreibvorgaenge
	// aneinander, und ein Abbruch dazwischen liesse die Kennung ins Leere zeigen.
	locals.db.transaction((tx) => {
		// Je Passkey genau eine Verpackung - eine zweite waere ein zweiter Weg zum
		// selben Schluessel.
		if (kind === "passkey" && credentialId) {
			tx.delete(keyWraps)
				.where(and(eq(keyWraps.userId, userId), eq(keyWraps.credentialId, credentialId)))
				.run();
		}

		if (kind === "recovery") {
			// Kennung und Nachweis gehoeren zu DIESER Verpackung und wandern mit ihr.
			if (recoveryId && vaultProof) {
				// Dieselbe Kennung bei zwei Konten hiesse dieselbe Phrase bei zweien.
				const foreign = tx.select().from(users).where(eq(users.recoveryId, recoveryId)).get();
				if (foreign && foreign.id !== userId) error(409, "Diese Phrase ist bereits vergeben");
				// Der Nachweis nur als Hash: siehe schema.ts und hashSecret.
				tx.update(users)
					.set({ recoveryId, vaultProof: hashSecret(vaultProof) })
					.where(eq(users.id, userId))
					.run();
			}

			// Genau eine Phrase je Konto: eine neue macht die alte ungueltig.
			tx.delete(keyWraps)
				.where(and(eq(keyWraps.userId, userId), eq(keyWraps.kind, "recovery")))
				.run();
		}

		tx.insert(keyWraps)
			.values({
				id,
				userId,
				kind: kind as "recovery" | "passkey" | "device",
				credentialId,
				payload,
				createdAt: Date.now()
			})
			.run();
	});

	return json({ id });
};
