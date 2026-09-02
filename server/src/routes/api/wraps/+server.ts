// Die verpackten Vault-Keys.
import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { keyWraps } from "$lib/server/db/schema";
import { eq } from "drizzle-orm";
import { readWrap, storeWrap, type WrapKind } from "$lib/server/wraps";

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
	if (!["recovery", "passkey", "device"].includes(kind)) error(400, "Unbekannte Art");

	const wrap = readWrap(body, kind as WrapKind);
	// Alles in EINER Transaktion: bei "recovery" haengen drei Schreibvorgaenge
	// aneinander, und ein Abbruch dazwischen liesse die Kennung ins Leere zeigen.
	const id = locals.db.transaction((tx) => storeWrap(tx, userId, wrap));
	return json({ id });
};
