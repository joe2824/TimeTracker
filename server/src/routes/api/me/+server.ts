// Wer bin ich - und was weiss der Server ueber meine Zugaenge.
import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { credentials, devices, keyWraps, users } from "$lib/server/db/schema";
import { eq } from "drizzle-orm";
import { currentSeq } from "$lib/server/sync";
import { deleteAccount, raeumeSpuren } from "$lib/server/account";
import { clearSessionCookie } from "$lib/server/session";
import { takeChallenge } from "$lib/server/auth";
import { verifyAuthentication } from "$lib/server/webauthn";

export const GET: RequestHandler = ({ locals }) => {
	if (!locals.userId) error(401, "Nicht angemeldet");
	const user = locals.db.select().from(users).where(eq(users.id, locals.userId)).get();
	if (!user) error(401, "Nicht angemeldet");

	return json({
		userId: user.id,
		displayName: user.displayName,
		email: user.email,
		isAdmin: user.isAdmin,
		seq: currentSeq(locals.db, user.id),
		// Nur die Art der Verpackungen, nie ihr Inhalt - der geht ueber /api/wraps
		// und ist auch dort undurchsichtig.
		wrapKinds: locals.db
			.select()
			.from(keyWraps)
			.where(eq(keyWraps.userId, user.id))
			.all()
			.map((w) => w.kind),
		passkeys: locals.db
			.select()
			.from(credentials)
			.where(eq(credentials.userId, user.id))
			.all()
			.map((c) => ({ id: c.id, hasPrf: c.hasPrf, createdAt: c.createdAt, lastUsedAt: c.lastUsedAt })),
		devices: locals.db
			.select()
			.from(devices)
			.where(eq(devices.userId, user.id))
			.all()
			.map((d) => ({ id: d.id, label: d.label, lastSeenAt: d.lastSeenAt, revokedAt: d.revokedAt }))
	});
};

/**
 * Das Konto aufloesen.
 *
 * Danach hat der Server nichts mehr: keine Chiffrate, keine Passkeys, keine
 * verpackten Schluessel, keine Geraete. Die lokalen Daten auf den Geraeten
 * bleiben davon unberuehrt - der Server war nie ihre einzige Kopie.
 *
 * WER DARF DAS. Die Antwort haengt daran, WOMIT sich die Anfrage ausweist, und
 * der Unterschied ist kein Schoenheitsfehler, sondern der Kern:
 *
 *   Sitzungs-Cookie - reicht NICHT. Ein Cookie faehrt bei jeder Anfrage
 *     automatisch mit; es beweist, dass irgendwann einmal jemand angemeldet war,
 *     nicht dass gerade jetzt jemand zustimmt. Verlangt wird eine frische
 *     WebAuthn-Bestaetigung mit Nutzerpruefung: derselbe Passkey, mit PIN oder
 *     Fingerabdruck, auf eine Aufgabe, die dieser Server vor Sekunden
 *     ausgegeben und an genau dieses Konto gebunden hat.
 *
 *   Geraete-Token - reicht. Es sind 256 Bit Zufall, die genau einmal bei der
 *     Kopplung ueber die Leitung gingen, die in keinem Browser-Kontext liegen
 *     und die automatisch nirgends mitfahren. Wer es hat, hat das gekoppelte
 *     Geraet - und damit ohnehin den Tresorschluessel und alle Daten. Eine
 *     zusaetzliche Huerde schuetzte hier nichts; sie wuerde nur so aussehen.
 *     Ein Passkey ist auf dem Desktop auch gar nicht verfuegbar: der Webview hat
 *     eine andere Herkunft als die Domain, an die Passkeys gebunden sind.
 */
export const DELETE: RequestHandler = async ({ locals, cookies, request }) => {
	if (!locals.userId) error(401, "Nicht angemeldet");
	const user = locals.db.select().from(users).where(eq(users.id, locals.userId)).get();
	if (!user) error(401, "Nicht angemeldet");

	// Kein Geraete-Token heisst: die Anfrage kam ueber das Cookie. Dann muss der
	// Mensch gerade eben zugestimmt haben.
	if (!locals.deviceId) {
		const body = await request.json().catch(() => null);
		const aufgabe = takeChallenge(locals.db, String(body?.challengeId ?? ""), "delete");
		if (!aufgabe) error(400, "Bestätigung abgelaufen – bitte erneut versuchen");
		// Die Aufgabe wurde fuer DIESES Konto ausgegeben. Ohne diese Zeile liesse
		// sich eine anderswo abgeholte Aufgabe hier einloesen.
		if (aufgabe.userId !== user.id) error(403, "Bestätigung gehört zu einem anderen Konto");

		const geprueft = await verifyAuthentication(
			locals.db,
			body?.response,
			aufgabe.challenge,
			// Nutzerpruefung ist Pflicht: der Passkey allein wuerde nur beweisen,
			// dass das Geraet da ist, nicht dass ein Mensch zugestimmt hat.
			true
		);
		if (!geprueft) error(401, "Bestätigung fehlgeschlagen");
		// Und der Passkey muss zu diesem Konto gehoeren - ein gueltiger Passkey
		// eines FREMDEN Kontos ist ebenfalls ein gueltiger Passkey.
		if (geprueft.userId !== user.id) error(403, "Passkey gehört zu einem anderen Konto");
	}

	// Alles oder nichts: ein halb geloeschtes Konto haette keinen Zugang mehr,
	// aber die Daten laegen noch da - und niemand koennte sie noch loeschen lassen.
	const summe = locals.db.transaction((tx) => deleteAccount(tx, user.id));
	// Erst NACH der Transaktion: waehrend sie laeuft, laesst sich das
	// Schreibprotokoll nicht abschneiden.
	raeumeSpuren(locals.db.$client);

	clearSessionCookie(cookies);
	return json({ ok: true, ...summe });
};
