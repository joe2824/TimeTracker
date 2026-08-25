// Schritt 2 der Registrierung: Antwort pruefen, Konto anlegen, anmelden.
import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { verifyRegistration, createUser, storeCredential } from "$lib/server/webauthn";
import { createSession, takeChallenge } from "$lib/server/auth";
import { INVITE_CODES, REGISTRATION_OPEN } from "$lib/server/config";
import { invites } from "$lib/server/db/schema";
import { and, eq, isNull } from "drizzle-orm";
import { setSessionCookie } from "$lib/server/session";

export const POST: RequestHandler = async ({ locals, request, cookies }) => {
	const body = await request.json().catch(() => null);
	const challengeId = String(body?.challengeId ?? "");
	const taken = takeChallenge(locals.db, challengeId, "register");
	if (!taken?.userId) error(400, "Aufgabe abgelaufen – bitte erneut versuchen");

	const displayName = String(body?.displayName ?? "").trim();
	if (!displayName) error(400, "Anzeigename fehlt");

	const verification = await verifyRegistration(body?.response, taken.challenge);
	if (!verification.verified || !verification.registrationInfo) {
		error(400, "Passkey konnte nicht bestätigt werden");
	}

	const code = String(body?.invite ?? "").trim();
	if (!REGISTRATION_OPEN && !INVITE_CODES.includes(code)) {
		// Ein Code aus der Tabelle gilt genau einmal. Die Entwertung passiert hier
		// und nicht beim Anfordern der Aufgabe: ein abgebrochener Versuch soll ihn
		// nicht verbrauchen.
		const r = locals.db
			.update(invites)
			.set({ usedAt: Date.now(), usedBy: taken.userId })
			.where(and(eq(invites.code, code), isNull(invites.usedAt)))
			.run();
		if (r.changes === 0) error(403, "Einladungscode ungültig");
	}

	const email = body?.email ? String(body.email).trim().toLowerCase() : null;

	// Konto, Passkey und Verpackung gehoeren zusammen: entweder entsteht alles,
	// oder nichts. Ein Konto ohne Passkey waere unerreichbar, ein Passkey ohne
	// Verpackung ein Tresor ohne Schluessel.
	locals.db.transaction((tx) => {
		createUser(tx, taken.userId!, displayName, email);
		storeCredential(
			tx,
			taken.userId!,
			verification.registrationInfo!.credential,
			verification.registrationInfo!.credential.transports,
			Boolean(body?.hasPrf)
		);
	});

	const secret = createSession(locals.db, taken.userId);
	setSessionCookie(cookies, secret);
	return json({ userId: taken.userId, displayName });
};

