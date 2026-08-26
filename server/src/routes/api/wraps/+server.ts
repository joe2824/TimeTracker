// Die verpackten Tresorschluessel.
//
// Fuer den Server sind das undurchsichtige Bytes. Er verwahrt sie, damit ein
// Geraet sie abholen kann - oeffnen kann sie nur, wer die Phrase, den passenden
// Passkey oder den privaten Geraeteschluessel hat.
import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { keyWraps, users } from "$lib/server/db/schema";
import { and, eq } from "drizzle-orm";
import { MAX_RECORD_BYTES } from "$lib/server/config";

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
	const body = await request.json().catch(() => null);
	const kind = String(body?.kind ?? "");
	const payload = String(body?.payload ?? "");
	if (!["recovery", "passkey", "device"].includes(kind)) error(400, "Unbekannte Art");
	if (!payload || payload.length > MAX_RECORD_BYTES) {
		error(400, "Verpackung fehlt oder ist zu groß");
	}

	const credentialId = body?.credentialId ? String(body.credentialId) : null;
	// Je Passkey genau eine Verpackung: eine zweite waere ein zweiter Weg zu
	// demselben Schluessel, den niemand mehr ueberblickt.
	if (kind === "passkey" && credentialId) {
		locals.db
			.delete(keyWraps)
			.where(and(eq(keyWraps.userId, locals.userId), eq(keyWraps.credentialId, credentialId)))
			.run();
	}
	if (kind === "recovery") {
		// Kennung und Nachweis gehoeren zu DIESER Verpackung: wer eine neue Phrase
		// erzeugt, macht die alte ungueltig, und beide muessen mitwandern. Sonst
		// zeigte die Kennung auf ein Konto, dessen Verpackung inzwischen eine
		// andere Phrase hat - und die Wiederherstellung liefe ins Leere.
		const recoveryId = body?.recoveryId ? String(body.recoveryId) : null;
		const vaultProof = body?.vaultProof ? String(body.vaultProof) : null;
		if (recoveryId || vaultProof) {
			const fremd = recoveryId
				? locals.db.select().from(users).where(eq(users.recoveryId, recoveryId)).get()
				: undefined;
			// Zwei Konten mit derselben Kennung waeren zwei Konten mit derselben
			// Phrase. Das kann nicht sein - und wenn doch, gehoert es abgewiesen,
			// nicht stillschweigend ueberschrieben.
			if (fremd && fremd.id !== locals.userId) error(409, "Diese Phrase ist bereits vergeben");
			locals.db
				.update(users)
				.set({ recoveryId, vaultProof })
				.where(eq(users.id, locals.userId))
				.run();
		}

		// Auch von der Phrase gibt es genau eine: wer eine neue erzeugt, macht die
		// alte damit ungueltig. Alles andere waere eine stille Hintertuer.
		locals.db
			.delete(keyWraps)
			.where(and(eq(keyWraps.userId, locals.userId), eq(keyWraps.kind, "recovery")))
			.run();
	}

	const id = crypto.randomUUID();
	locals.db
		.insert(keyWraps)
		.values({
			id,
			userId: locals.userId,
			kind: kind as "recovery" | "passkey" | "device",
			credentialId,
			payload,
			createdAt: Date.now()
		})
		.run();
	return json({ id });
};
