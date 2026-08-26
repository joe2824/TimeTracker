// Ein Konto von einem GERAET aus anlegen - ohne Passkey.
//
// Warum es das gibt: Passkeys haengen an einer Domain, und die Desktop-Anwendung
// hat keine. Bisher musste deshalb jeder erst in den Browser, ein Konto anlegen
// und dann den Rechner koppeln - und das ist genau verkehrt herum. Die Daten
// liegen auf dem Rechner. Er ist das Hauptgeraet, nicht der Zweitweg.
//
// Was so ein Konto hat und was nicht:
//
//   ES HAT   ein Geraete-Token fuer dieses eine Geraet, und eine
//            Wiederherstellungs-Phrase, die der Client erzeugt und ablegt.
//            Damit laeuft der Abgleich, und der Tresor laesst sich oeffnen.
//
//   ES HAT NICHT   einen Passkey. Im Browser kommt man damit zunaechst nicht
//            hinein. Der Weg dorthin fuehrt ueber die Kopplung: der Browser
//            meldet sich wie jedes andere neue Geraet an, der Rechner
//            bestaetigt, und danach laesst sich dort ein Passkey anlegen.
//
// Der wichtige Teil ist der zweite. Ein Konto, das nur an einem Rechner haengt,
// ist genau so viel wert wie dieser Rechner - deshalb sagt die Oberflaeche
// ausdruecklich, dass die Phrase der einzige Weg zurueck ist, solange kein
// zweites Geraet dazugekommen ist.
import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { REGISTRATION_OPEN } from "$lib/server/config";
import { entwerteCode, gueltigerCode } from "$lib/server/invites";
import { createDevice } from "$lib/server/auth";
import { createUser } from "$lib/server/webauthn";

export const POST: RequestHandler = async ({ locals, request }) => {
	const body = await request.json().catch(() => null);

	const displayName = String(body?.displayName ?? "").trim();
	if (!displayName || displayName.length > 64) error(400, "Anzeigename fehlt oder ist zu lang");

	const label = String(body?.label ?? "Dieser Rechner").trim().slice(0, 64);
	const code = String(body?.invite ?? "").trim();
	if (!REGISTRATION_OPEN && !gueltigerCode(locals.db, code)) {
		error(403, "Einladungscode ungültig");
	}

	const userId = crypto.randomUUID();
	const email = body?.email ? String(body.email).trim().toLowerCase() : null;

	// Konto und Geraet gehoeren zusammen: entweder entsteht beides, oder nichts.
	// Ein Konto ohne Geraet waere unerreichbar - es gibt ja keinen Passkey, mit
	// dem man sich stattdessen anmelden koennte.
	const geraet = locals.db.transaction((tx) => {
		createUser(tx, userId, displayName, email);
		if (!REGISTRATION_OPEN) entwerteCode(tx, code, userId);
		return createDevice(tx, userId, label);
	});

	return json({
		userId,
		displayName,
		deviceId: geraet.id,
		// Genau einmal. Danach steht nur noch der Hash in der Datenbank.
		deviceToken: geraet.token
	});
};
