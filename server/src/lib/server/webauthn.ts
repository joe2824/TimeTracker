// Passkeys: registrieren und anmelden.
import {
	generateAuthenticationOptions,
	generateRegistrationOptions,
	verifyAuthenticationResponse,
	verifyRegistrationResponse
} from "@simplewebauthn/server";
import type {
	AuthenticationResponseJSON,
	AuthenticatorTransportFuture,
	RegistrationResponseJSON
} from "@simplewebauthn/server";
import { eq } from "drizzle-orm";
import type { Db, DbLike } from "./db";
import { credentials, users } from "./db/schema";
import { RP_ID, RP_NAME, WEBAUTHN_ORIGINS } from "./config";

/** Die PRF-Erweiterung anfordern. */
const PRF_EXTENSION = { prf: {} } as unknown as AuthenticationExtensionsClientInputs;

/**
 * Was der Passkey-Verwalter spaeter anzeigt.
 *
 * Ein Konto aus der Desktop-Anwendung traegt keinen Namen - dort steht dann die
 * Kennung, und im Schluesselbund liest man eine nackte UUID. Stattdessen der
 * Name der Anwendung und die Adresse, unter der sie laeuft.
 *
 * Der Wert wird beim Anlegen in den Passkey geschrieben und aendert sich danach
 * nicht mehr, auch wenn das Konto spaeter einen Namen bekommt.
 */
export function passkeyLabel(displayName: string, userId: string): string {
	const human = displayName.trim();
	const hasName = human !== "" && human !== userId;
	return hasName ? `${human} · ${RP_ID}` : `${RP_NAME} · ${RP_ID}`;
}

export async function registrationOptions(displayName: string, userId: string) {
	const label = passkeyLabel(displayName, userId);
	return generateRegistrationOptions({
		rpName: RP_NAME,
		rpID: RP_ID,
		userID: new TextEncoder().encode(userId),
		userName: label,
		userDisplayName: label,
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
		// Mehrere Adressen sind erlaubt, solange alle unter derselben Kennung
		// liegen - die Auswahl trifft config.ts, nicht diese Stelle.
		expectedOrigin: WEBAUTHN_ORIGINS,
		expectedRPID: RP_ID,
		requireUserVerification: false
	});
}

/** Die Aufgabe fuer eine BESTAETIGUNG, nicht fuer eine Anmeldung. */
export async function confirmationOptions(db: Db, userId: string) {
	const own = db.select().from(credentials).where(eq(credentials.userId, userId)).all();
	return generateAuthenticationOptions({
		rpID: RP_ID,
		// Anders als bei der Anmeldung wird hier eingeschraenkt: es ist bereits
		// bekannt, wer bestaetigt. Ein fremder Passkey darf gar nicht erst
		// angeboten werden.
		allowCredentials: own.map((c) => ({
			id: c.id,
			transports: c.transports
				? (JSON.parse(c.transports) as AuthenticatorTransportFuture[])
				: undefined
		})),
		userVerification: "required"
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
	expectedChallenge: string,
	/** Ob der Authentifikator den Menschen geprueft haben muss. */
	requireUserVerification = false
) {
	const cred = db.select().from(credentials).where(eq(credentials.id, response.id)).get();
	if (!cred) return null;

	const result = await verifyAuthenticationResponse({
		response,
		expectedChallenge,
		expectedOrigin: WEBAUTHN_ORIGINS,
		expectedRPID: RP_ID,
		credential: {
			id: cred.id,
			publicKey: new Uint8Array(cred.publicKey),
			counter: cred.counter,
			transports: cred.transports ? JSON.parse(cred.transports) : undefined
		},
		requireUserVerification
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
	/** Wie der Mensch ihn nennt. Beim ersten Passkey noch niemand - dann null. */
	label: string | null = null
): void {
	db.insert(credentials)
		.values({
			id: cred.id,
			userId,
			publicKey: Buffer.from(cred.publicKey),
			counter: cred.counter,
			transports: transports ? JSON.stringify(transports) : null,
			label,
			createdAt: Date.now()
		})
		.run();
}
