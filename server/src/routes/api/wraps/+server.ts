// Die verpackten Vault-Keys.
import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { keyWraps } from "$lib/server/db/schema";
import { eq } from "drizzle-orm";
import { readWrap, storeWrap, type WrapKind } from "$lib/server/wraps";
import { readJson } from "$lib/server/request";
import { requireUser } from "$lib/server/guards";

export const GET: RequestHandler = ({ locals }) => {
	const userId = requireUser(locals);
	return json({
		wraps: locals.db
			.select()
			.from(keyWraps)
			.where(eq(keyWraps.userId, userId))
			.all()
			.map((w) => ({ id: w.id, kind: w.kind, credentialId: w.credentialId, payload: w.payload }))
	});
};

export const POST: RequestHandler = async ({ locals, request }) => {
	const userId = requireUser(locals);
	const body = await readJson(request);
	const kind = String(body?.kind ?? "");
	if (!["recovery", "passkey"].includes(kind)) error(400, "Unbekannte Art");

	const wrap = readWrap(body, kind as WrapKind);
	// Alles in EINER Transaktion: bei "recovery" hängen drei Schreibvorgänge
	// aneinander, und ein Abbruch dazwischen liesse die Kennung ins Leere zeigen.
	const id = locals.db.transaction((tx) => storeWrap(tx, userId, wrap));
	return json({ id });
};
