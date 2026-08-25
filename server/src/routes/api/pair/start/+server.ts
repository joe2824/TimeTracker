// Kopplung, Schritt 1 - auf dem NEUEN Geraet.
//
// Es erzeugt ein fluechtiges Schluesselpaar und hinterlegt den oeffentlichen
// Teil unter einem kurzen Code. Diesen Code liest der Mensch ab und tippt ihn auf
// einem bereits entsperrten Geraet ein.
//
// Ausdruecklich OHNE Anmeldung: das neue Geraet hat ja noch keine.
import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { pairings } from "$lib/server/db/schema";
import { PAIRING_TTL_MS } from "$lib/server/config";
import { randomInt } from "node:crypto";

/**
 * Der Code, den jemand abtippt.
 *
 * Ohne I, O, 0 und 1 - die werden beim Abschreiben verwechselt. Acht Zeichen aus
 * 32 sind 40 Bit; zusammen mit der kurzen Gueltigkeit ist Raten aussichtslos.
 */
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function neuerCode(): string {
	let out = "";
	for (let i = 0; i < 8; i++) out += ALPHABET[randomInt(ALPHABET.length)];
	return out;
}

export const POST: RequestHandler = async ({ locals, request }) => {
	const body = await request.json().catch(() => null);
	const publicKey = String(body?.publicKey ?? "");
	const label = String(body?.label ?? "Neues Gerät").slice(0, 64);
	if (!publicKey || publicKey.length > 512) error(400, "Öffentlicher Schlüssel fehlt");

	// Der Vorgang haengt noch an keinem Konto: welches es wird, entscheidet sich
	// erst, wenn ein entsperrtes Geraet ihn bestaetigt.
	const code = neuerCode();
	const expiresAt = Date.now() + PAIRING_TTL_MS;
	locals.db
		.insert(pairings)
		.values({ code, userId: null, publicKey, label, createdAt: Date.now(), expiresAt })
		.run();
	return json({ code, expiresAt });
};
