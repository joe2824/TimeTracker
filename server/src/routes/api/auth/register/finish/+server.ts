// Schritt 2 der Registrierung: Antwort pruefen, Konto anlegen, anmelden.
import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { verifyRegistration, createUser, storeCredential } from "$lib/server/webauthn";
import { createSession, takeChallenge } from "$lib/server/auth";
import { REGISTRATION_OPEN } from "$lib/server/config";
import { entwerteCode, gueltigerCode } from "$lib/server/invites";
import { setSessionCookie } from "$lib/server/session";

export const POST: RequestHandler = async ({ locals, request, cookies }) => {
	const body = await request.json().catch(() => null);
	const challengeId = String(body?.challengeId ?? "");
	const taken = takeChallenge(locals.db, challengeId, "register");
	if (!taken?.userId) error(400, "Aufgabe abgelaufen – bitte erneut versuchen");

	const gewuenscht = String(body?.displayName ?? "").trim();
	if (gewuenscht.length > 64) error(400, "Anzeigename ist zu lang");
	// Ohne Namen die Kennung - dieselbe Regel wie beim Anlegen vom Geraet aus.
	const displayName = gewuenscht || taken.userId;

	const verification = await verifyRegistration(body?.response, taken.challenge);
	if (!verification.verified || !verification.registrationInfo) {
		error(400, "Passkey konnte nicht bestätigt werden");
	}

	const code = String(body?.invite ?? "").trim();
	// Erst pruefen, entwertet wird unten IN der Transaktion. Andersherum waere die
	// Einladung verbraucht, wenn das Anlegen danach scheitert - und niemand haette
	// ein Konto dafuer.
	if (!REGISTRATION_OPEN && !gueltigerCode(locals.db, code)) {
		error(403, "Einladungscode ungültig");
	}

	const email = body?.email ? String(body.email).trim().toLowerCase() : null;

	// Konto, Passkey und Verpackung gehoeren zusammen: entweder entsteht alles,
	// oder nichts. Ein Konto ohne Passkey waere unerreichbar, ein Passkey ohne
	// Verpackung ein Tresor ohne Schluessel.
	locals.db.transaction((tx) => {
		createUser(tx, taken.userId!, displayName, email);
		// Ein Code aus der Tabelle gilt genau einmal. Hier drin, damit "Konto
		// entstanden" und "Einladung verbraucht" nicht auseinanderfallen koennen.
		if (!REGISTRATION_OPEN) entwerteCode(tx, code, taken.userId!);
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

