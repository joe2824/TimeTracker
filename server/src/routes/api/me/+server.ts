// Wer bin ich - und was weiss der Server über meine Zugänge.
import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { listPasskeys } from "$lib/server/passkeys";
import { devices, keyWraps, users } from "$lib/server/db/schema";
import { eq } from "drizzle-orm";
import { currentSeq } from "$lib/server/sync";
import { deleteAccount, cleanupTraces } from "$lib/server/account";
import { clearSessionCookie } from "$lib/server/session";
import { takeChallenge } from "$lib/server/auth";
import { verifyAuthentication } from "$lib/server/webauthn";
import { readJson } from "$lib/server/request";
import { requireUserRow } from "$lib/server/guards";
import { LABEL_MAX, readLabel } from "$shared/labels";

export const GET: RequestHandler = ({ locals }) => {
	const user = requireUserRow(locals);

	return json({
		userId: user.id,
		displayName: user.displayName,
		email: user.email,
		isAdmin: user.isAdmin,
		seq: currentSeq(locals.db, user.id),
		// Nur die Art der Verpackungen, nie ihr Inhalt - der geht über /api/wraps
		// und ist auch dort undurchsichtig.
		wrapKinds: locals.db
			.select()
			.from(keyWraps)
			.where(eq(keyWraps.userId, user.id))
			.all()
			.map((w) => w.kind),
		passkeys: listPasskeys(locals.db, user.id),
		devices: locals.db
			.select()
			.from(devices)
			.where(eq(devices.userId, user.id))
			.all()
			.map((d) => ({ id: d.id, label: d.label, lastSeenAt: d.lastSeenAt, revokedAt: d.revokedAt }))
	});
};

/** Profildaten aktualisieren (z.B. Anzeigename aus den Einstellungen). */
export const PATCH: RequestHandler = async ({ locals, request }) => {
	const user = requireUserRow(locals);

	const body = await readJson(request);
	// Gekürzt statt abgelehnt - anders als bei der Registrierung (readDisplayName).
	if (typeof body?.displayName === "string") {
		const displayName = readLabel(body.displayName, user.id, LABEL_MAX);
		locals.db.update(users).set({ displayName }).where(eq(users.id, user.id)).run();
		return json({ ok: true, displayName });
	}

	return json({ ok: true, displayName: user.displayName });
};

/** Das Konto auflösen. */
export const DELETE: RequestHandler = async ({ locals, cookies, request }) => {
	const user = requireUserRow(locals);

	// Kein Geräte-Token heisst: die Anfrage kam über das Cookie. Dann muss der
	// Mensch gerade eben zugestimmt haben.
	if (!locals.deviceId) {
		const body = await readJson(request);
		const task = takeChallenge(locals.db, String(body?.challengeId ?? ""), "delete");
		if (!task) error(400, "Bestätigung abgelaufen – bitte erneut versuchen");
		// Die Aufgabe wurde für DIESES Konto ausgegeben. Ohne diese Zeile liesse
		// sich eine anderswo abgeholte Aufgabe hier einlösen.
		if (task.userId !== user.id) error(403, "Bestätigung gehört zu einem anderen Konto");

		const checked = await verifyAuthentication(
			locals.db,
			body?.response,
			task.challenge,
			// Nutzerprüfung ist Pflicht: der Passkey allein würde nur beweisen,
			// dass das Gerät da ist, nicht dass ein Mensch zugestimmt hat.
			true
		);
		if (!checked) error(401, "Bestätigung fehlgeschlagen");
		// Und der Passkey muss zu diesem Konto gehören - ein gültiger Passkey
		// eines FREMDEN Kontos ist ebenfalls ein gültiger Passkey.
		if (checked.userId !== user.id) error(403, "Passkey gehört zu einem anderen Konto");
	}

	// Alles oder nichts: ein halb gelöschtes Konto hätte keinen Zugang mehr,
	// aber die Daten lägen noch da - und niemand könnte sie noch löschen lassen.
	const summary = locals.db.transaction((tx) => deleteAccount(tx, user.id));
	// Erst NACH der Transaktion: während sie läuft, lässt sich das
	// Schreibprotokoll nicht abschneiden.
	cleanupTraces(locals.db.$client);

	clearSessionCookie(cookies);
	return json({ ok: true, ...summary });
};
