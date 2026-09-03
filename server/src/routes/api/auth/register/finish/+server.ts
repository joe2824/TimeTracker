// Schritt 2 der Registrierung: Antwort pruefen, Konto anlegen, anmelden.
import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { verifyRegistration, createUser, storeCredential } from "$lib/server/webauthn";
import { createSession, takeChallenge } from "$lib/server/auth";
import { consumeCode, validCode, isRegistrationOpen } from "$lib/server/invites";
import { setSessionCookie } from "$lib/server/session";
import { readWrap, storeWrap } from "$lib/server/wraps";

export const POST: RequestHandler = async ({ locals, request, cookies }) => {
	const body = await request.json().catch(() => null);
	const challengeId = String(body?.challengeId ?? "");
	const taken = takeChallenge(locals.db, challengeId, "register");
	if (!taken?.userId) error(400, "Aufgabe abgelaufen – bitte erneut versuchen");

	const requested = String(body?.displayName ?? "").trim();
	if (requested.length > 64) error(400, "Anzeigename ist zu lang");
	// Ohne Namen die Kennung - dieselbe Regel wie beim Anlegen vom Geraet aus.
	const displayName = requested || taken.userId;

	const verification = await verifyRegistration(body?.response, taken.challenge);
	if (!verification.verified || !verification.registrationInfo) {
		error(400, "Passkey konnte nicht bestätigt werden");
	}

	const code = String(body?.invite ?? "").trim();
	// Erst pruefen, entwertet wird unten IN der Transaktion. Andersherum waere die
	// Einladung verbraucht, wenn das Anlegen danach scheitert - und niemand haette
	// ein Konto dafuer.
	if (!isRegistrationOpen(locals.db) && !validCode(locals.db, code)) {
		error(403, "Einladungscode ungültig");
	}

	const email = body?.email ? String(body.email).trim().toLowerCase() : null;

	// Die Phrasen-Verpackung ist Pflicht: ohne sie gaebe es keinen Weg zurueck,
	// und das faellt erst auf, wenn er gebraucht wird.
	const recovery = readWrap(body?.recoveryWrap, "recovery");
	// Die Passkey-Verpackung kann fehlen - dann kann der Authentifikator kein PRF.
	const passkey = body?.passkeyWrap ? readWrap(body.passkeyWrap, "passkey") : null;
	if (passkey) passkey.credentialId = verification.registrationInfo.credential.id;

	// Konto, Passkey und Verpackung gehoeren zusammen: entweder entsteht alles,
	// oder nichts. Ein Konto ohne Passkey waere unerreichbar, ein Passkey ohne
	// Verpackung ein Vault ohne Schluessel - und das merkt niemand, solange der
	// Schluessel noch lokal liegt.
	locals.db.transaction((tx) => {
		createUser(tx, taken.userId!, displayName, email);
		// Ein Code aus der Tabelle gilt genau einmal. Hier drin, damit "Konto
		// entstanden" und "Einladung verbraucht" nicht auseinanderfallen koennen.
		if (!isRegistrationOpen(locals.db) && code) consumeCode(tx, code, taken.userId!);
		storeCredential(
			tx,
			taken.userId!,
			verification.registrationInfo!.credential,
			verification.registrationInfo!.credential.transports
		);
		storeWrap(tx, taken.userId!, recovery);
		if (passkey) storeWrap(tx, taken.userId!, passkey);
	});

	const secret = createSession(locals.db, taken.userId);
	setSessionCookie(cookies, secret);
	return json({ userId: taken.userId, displayName });
};

