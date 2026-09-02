// Passkeys benennen und entfernen.
//
// Die LISTE kommt aus /api/me - sie steht dort ohnehin, zusammen mit Konto und
// Geraeten, und zwei Endpunkte fuer dieselben Zeilen liefen prompt auseinander.
// Das Anlegen laeuft ueber /start und /finish: es braucht zwei Schritte, weil
// ein Authentifikator dazwischen den Menschen fragt.
import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { credentials, keyWraps } from "$lib/server/db/schema";
import { and, eq } from "drizzle-orm";

/** Umbenennen - damit in der Liste steht, welches Geraet gemeint ist. */
export const PATCH: RequestHandler = async ({ locals, request }) => {
	if (!locals.userId) error(401, "Nicht angemeldet");
	const body = await request.json().catch(() => null);
	const hostId = String(body?.id ?? "");
	const label = String(body?.label ?? "").trim().slice(0, 64) || null;

	const r = locals.db
		.update(credentials)
		.set({ label })
		.where(and(eq(credentials.id, hostId), eq(credentials.userId, locals.userId)))
		.run();
	if (r.changes === 0) error(404, "Passkey unbekannt");
	return json({ ok: true, label });
};

/** Einen Passkey entfernen. */
export const DELETE: RequestHandler = async ({ locals, request }) => {
	if (!locals.userId) error(401, "Nicht angemeldet");
	const body = await request.json().catch(() => null);
	const hostId = String(body?.id ?? "");
	const userId = locals.userId;

	const all = locals.db.select().from(credentials).where(eq(credentials.userId, userId)).all();
	if (!all.some((c) => c.id === hostId)) error(404, "Passkey unbekannt");
	if (all.length <= 1) {
		error(409, "Das ist der letzte Passkey – ohne ihn käme niemand mehr in das Konto");
	}

	locals.db.transaction((tx) => {
		tx.delete(credentials)
			.where(and(eq(credentials.id, hostId), eq(credentials.userId, userId)))
			.run();
		// Die Verpackung, die an diesem Passkey hing, laesst sich ohne ihn nicht
		// mehr oeffnen. Sie stehen zu lassen hiesse, eine Tuer ohne Schluessel zu
		// verwahren.
		tx.delete(keyWraps)
			.where(and(eq(keyWraps.userId, userId), eq(keyWraps.credentialId, hostId)))
			.run();
	});

	return json({ ok: true });
};
