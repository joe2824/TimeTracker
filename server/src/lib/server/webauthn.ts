// Passkeys: registrieren und anmelden.
//
// Die eigentliche Kryptografie macht @simplewebauthn/server. Was hier steht, ist
// die Verbindung zu unserem Schema und die eine Entscheidung, die das Produkt
// praegt: es gibt kein Passwort und keine Pflicht-Mailadresse. Ein Konto besteht
// aus einem Anzeigenamen und mindestens einem Passkey.
import {
	generateAuthenticationOptions,
	generateRegistrationOptions,
	verifyAuthenticationResponse,
	verifyRegistrationResponse
} from "@simplewebauthn/server";
import type {
	AuthenticationResponseJSON,
	RegistrationResponseJSON
} from "@simplewebauthn/server";
import { eq } from "drizzle-orm";
import type { Db, DbLike } from "./db";
import { credentials, users } from "./db/schema";
import { ORIGIN, RP_ID, RP_NAME } from "./config";

/**
 * Die PRF-Erweiterung anfordern.
 *
 * Wenn der Authentifikator sie kann, liefert derselbe Passkey spaeter einen
 * stabilen Zufallswert, aus dem sich der Tresorschluessel oeffnen laesst - die
 * Anmeldung entsperrt die Daten dann in derselben Bewegung.
 *
 * Kann er sie nicht (Windows Hello ueber TPM je nach Fassung), faellt das hier
 * nicht auf: die Registrierung laeuft normal weiter, und der Tresor wird ueber
 * die Wiederherstellungs-Phrase oder ein bereits entsperrtes Geraet geoeffnet.
 * Genau deshalb ist die Phrase Pflicht und nicht Kuer.
 *
 * Der Cast ist noetig, weil die Typdefinition des Browsers `prf` noch nicht
 * kennt - die Erweiterung ist neuer als die Typen. Uebertragen wird sie
 * trotzdem korrekt; wer sie nicht kann, ignoriert sie schlicht.
 */
const PRF_EXTENSION = { prf: {} } as unknown as AuthenticationExtensionsClientInputs;

export async function registrationOptions(displayName: string, userId: string) {
	return generateRegistrationOptions({
		rpName: RP_NAME,
		rpID: RP_ID,
		userID: new TextEncoder().encode(userId),
		userName: displayName,
		userDisplayName: displayName,
		// Der Passkey soll auf dem Geraet bleiben und dort auffindbar sein - nur
		// dann kann man sich ohne Benutzernamen anmelden.
		authenticatorSelection: { residentKey: "required", userVerification: "preferred" },
		attestationType: "none",
		extensions: PRF_EXTENSION
	});
}

export async function verifyRegistration(
	response: RegistrationResponseJSON,
	expectedChallenge: string
) {
	return verifyRegistrationResponse({
		response,
		expectedChallenge,
		expectedOrigin: ORIGIN,
		expectedRPID: RP_ID,
		requireUserVerification: false
	});
}

export async function authenticationOptions() {
	return generateAuthenticationOptions({
		rpID: RP_ID,
		// Keine Liste erlaubter Passkeys: der Browser zeigt selbst an, welche er
		// fuer diese Adresse hat. Eine Liste verriete ausserdem, welche Konten es
		// gibt.
		userVerification: "preferred",
		extensions: PRF_EXTENSION
	});
}

export async function verifyAuthentication(
	db: Db,
	response: AuthenticationResponseJSON,
	expectedChallenge: string
) {
	const cred = db.select().from(credentials).where(eq(credentials.id, response.id)).get();
	if (!cred) return null;

	const result = await verifyAuthenticationResponse({
		response,
		expectedChallenge,
		expectedOrigin: ORIGIN,
		expectedRPID: RP_ID,
		credential: {
			id: cred.id,
			publicKey: new Uint8Array(cred.publicKey),
			counter: cred.counter,
			transports: cred.transports ? JSON.parse(cred.transports) : undefined
		},
		requireUserVerification: false
	});
	if (!result.verified) return null;

	// Den Zaehler mitfuehren: springt er zurueck, ist der Authentifikator geklont.
	// Wir weisen das nicht ab (viele Passkeys zaehlen gar nicht), aber der Wert
	// gehoert festgehalten.
	db.update(credentials)
		.set({ counter: result.authenticationInfo.newCounter, lastUsedAt: Date.now() })
		.where(eq(credentials.id, cred.id))
		.run();

	return { userId: cred.userId, credentialId: cred.id };
}

/** Das Konto anlegen, zu dem der erste Passkey gehoert. */
export function createUser(db: DbLike, id: string, displayName: string, email: string | null): void {
	db.insert(users).values({ id, displayName, email, createdAt: Date.now(), seqCounter: 0 }).run();
}

export function storeCredential(
	db: DbLike,
	userId: string,
	cred: { id: string; publicKey: Uint8Array; counter: number },
	transports: string[] | undefined,
	hasPrf: boolean
): void {
	db.insert(credentials)
		.values({
			id: cred.id,
			userId,
			publicKey: Buffer.from(cred.publicKey),
			counter: cred.counter,
			transports: transports ? JSON.stringify(transports) : null,
			hasPrf,
			createdAt: Date.now()
		})
		.run();
}
