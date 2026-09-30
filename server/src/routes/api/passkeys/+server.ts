// Passkeys benennen und entfernen.
//
// Die LISTE kommt aus /api/me - sie steht dort ohnehin, zusammen mit Konto und
// Geräten, und zwei Endpunkte für dieselben Zeilen liefen prompt auseinander.
// Das Anlegen läuft über /start und /finish: es braucht zwei Schritte, weil
// ein Authentifikator dazwischen den Menschen fragt.
import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { credentials, keyWraps } from "$lib/server/db/schema";
import { and, eq } from "drizzle-orm";
import { readJson } from "$lib/server/request";
import { requireUser } from "$lib/server/guards";
import { LABEL_MAX, readLabel } from "$shared/labels";
import { listCredentials } from "$lib/server/webauthn";

/** Umbenennen - damit in der Liste steht, welches Gerät gemeint ist. */
export const PATCH: RequestHandler = async ({ locals, request }) => {
	const userId = requireUser(locals);
	const body = await readJson(request);
	const hostId = String(body?.id ?? "");
	const label = readLabel(body?.label, null, LABEL_MAX);

	const r = locals.db
		.update(credentials)
		.set({ label })
		.where(and(eq(credentials.id, hostId), eq(credentials.userId, userId)))
		.run();
	if (r.changes === 0) error(404, "Passkey unbekannt");
	return json({ ok: true, label });
};

/** Einen Passkey entfernen. */
export const DELETE: RequestHandler = async ({ locals, request }) => {
	const userId = requireUser(locals);
	const body = await readJson(request);
	const hostId = String(body?.id ?? "");

	const all = listCredentials(locals.db, userId);
	if (!all.some((c) => c.id === hostId)) error(404, "Passkey unbekannt");
	if (all.length <= 1) {
		error(409, "Das ist der letzte Passkey – ohne ihn käme niemand mehr in das Konto");
	}

	locals.db.transaction((tx) => {
		tx.delete(credentials)
			.where(and(eq(credentials.id, hostId), eq(credentials.userId, userId)))
			.run();
		// Die Verpackung, die an diesem Passkey hing, lässt sich ohne ihn nicht
		// mehr öffnen. Sie stehen zu lassen hiesse, eine Tür ohne Schlüssel zu
		// verwahren.
		tx.delete(keyWraps)
			.where(and(eq(keyWraps.userId, userId), eq(keyWraps.credentialId, hostId)))
			.run();
	});

	return json({ ok: true });
};
