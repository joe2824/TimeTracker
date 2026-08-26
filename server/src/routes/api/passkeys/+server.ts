// Passkeys ansehen, benennen, entfernen.
//
// Das Anlegen laeuft ueber /start und /finish - es braucht zwei Schritte, weil
// ein Authentifikator dazwischen den Menschen fragt.
import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { credentials, keyWraps } from "$lib/server/db/schema";
import { and, eq } from "drizzle-orm";

export const GET: RequestHandler = ({ locals }) => {
	if (!locals.userId) error(401, "Nicht angemeldet");
	return json({
		passkeys: locals.db
			.select()
			.from(credentials)
			.where(eq(credentials.userId, locals.userId))
			.all()
			.map((c) => ({
				id: c.id,
				label: c.label,
				hasPrf: c.hasPrf,
				createdAt: c.createdAt,
				lastUsedAt: c.lastUsedAt
			}))
	});
};

/** Umbenennen - damit in der Liste steht, welches Geraet gemeint ist. */
export const PATCH: RequestHandler = async ({ locals, request }) => {
	if (!locals.userId) error(401, "Nicht angemeldet");
	const body = await request.json().catch(() => null);
	const kennung = String(body?.id ?? "");
	const label = String(body?.label ?? "").trim().slice(0, 64) || null;

	const r = locals.db
		.update(credentials)
		.set({ label })
		.where(and(eq(credentials.id, kennung), eq(credentials.userId, locals.userId)))
		.run();
	if (r.changes === 0) error(404, "Passkey unbekannt");
	return json({ ok: true, label });
};

/**
 * Einen Passkey entfernen.
 *
 * Mit einer Grenze, die nicht verhandelbar ist: der LETZTE geht nicht. Ohne
 * Passkey gibt es keinen Weg mehr in das Konto - die Wiederherstellungs-Phrase
 * entsperrt die DATEN, aber sie meldet niemanden an. Wer den letzten loeschte,
 * haette ein Konto, in das niemand mehr hineinkommt, und der Betreiber koennte
 * auch nicht helfen: er kann nichts entschluesseln.
 *
 * Wer wirklich alles loswerden will, loest das Konto auf (DELETE /api/me). Das
 * ist derselbe Verlust, aber ausgesprochen.
 */
export const DELETE: RequestHandler = async ({ locals, request }) => {
	if (!locals.userId) error(401, "Nicht angemeldet");
	const body = await request.json().catch(() => null);
	const kennung = String(body?.id ?? "");
	const userId = locals.userId;

	const alle = locals.db.select().from(credentials).where(eq(credentials.userId, userId)).all();
	if (!alle.some((c) => c.id === kennung)) error(404, "Passkey unbekannt");
	if (alle.length <= 1) {
		error(409, "Das ist der letzte Passkey – ohne ihn käme niemand mehr in das Konto");
	}

	locals.db.transaction((tx) => {
		tx.delete(credentials)
			.where(and(eq(credentials.id, kennung), eq(credentials.userId, userId)))
			.run();
		// Die Verpackung, die an diesem Passkey hing, laesst sich ohne ihn nicht
		// mehr oeffnen. Sie stehen zu lassen hiesse, eine Tuer ohne Schluessel zu
		// verwahren.
		tx.delete(keyWraps)
			.where(and(eq(keyWraps.userId, userId), eq(keyWraps.credentialId, kennung)))
			.run();
	});

	return json({ ok: true });
};
