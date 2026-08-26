// Ein Konto anlegen und sich anmelden - im Browser, weil Passkeys an die Domain
// gebunden sind. Die Desktop-Anwendung koppelt sich stattdessen (account.svelte.ts).
import { startAuthentication, startRegistration } from "@simplewebauthn/browser";
import type {
	AuthenticationResponseJSON,
	PublicKeyCredentialCreationOptionsJSON,
	PublicKeyCredentialRequestOptionsJSON,
	RegistrationResponseJSON
} from "@simplewebauthn/browser";
import {
	createRecoveryPhrase,
	createVaultKey,
	fromBase64,
	importVaultKey,
	isValidRecoveryPhrase,
	recoveryLookupId,
	toBase64,
	unwrapWithPhrase,
	unwrapWithPrf,
	vaultProof,
	wrapWithPhrase,
	wrapWithPrf,
	type KeyWrap
} from "../crypto/vault";
import { Api, ApiError } from "./api";
import { platformFetch } from "../platform/http";

/** Was der Server unter einer Verpackung versteht: JSON mit base64-Feldern. */
function serialize(wrap: KeyWrap): string {
	return JSON.stringify({
		kind: wrap.kind,
		salt: toBase64(wrap.salt),
		iv: toBase64(wrap.iv),
		wrapped: toBase64(wrap.wrapped),
		...(wrap.ephemeralPublicKey
			? { ephemeralPublicKey: toBase64(wrap.ephemeralPublicKey) }
			: {})
	});
}

function deserialize(payload: string): KeyWrap {
	const d = JSON.parse(payload);
	return {
		kind: d.kind,
		salt: fromBase64(d.salt),
		iv: fromBase64(d.iv),
		wrapped: fromBase64(d.wrapped),
		...(d.ephemeralPublicKey ? { ephemeralPublicKey: fromBase64(d.ephemeralPublicKey) } : {})
	};
}

/** Die Verpackung mit der Phrase oeffnen - oder verstaendlich scheitern. */
async function oeffneMitPhrase(payload: string, phrase: string): Promise<CryptoKey> {
	try {
		return await unwrapWithPhrase(deserialize(payload), phrase);
	} catch {
		throw new Error("Die Wörter passen nicht zu diesem Konto – bitte noch einmal prüfen.");
	}
}

/**
 * Feste Eingabe fuer die PRF-Erweiterung - muss bei jeder Anmeldung dieselbe
 * sein, sonst faellt ein anderer Wert heraus. Kein Geheimnis.
 */
const PRF_INPUT = new TextEncoder().encode("timetracker-vault-v1");

/** Was ein Authentifikator zurueckgab, sofern er PRF kann. */
function prfOf(response: RegistrationResponseJSON | AuthenticationResponseJSON): ArrayBuffer | null {
	const ext = response.clientExtensionResults as {
		prf?: { enabled?: boolean; results?: { first?: ArrayBuffer | Uint8Array } };
	};
	const first = ext?.prf?.results?.first;
	if (!first) return null;
	return first instanceof Uint8Array ? (first.buffer as ArrayBuffer) : first;
}

/** Die PRF-Eingabe an die Optionen haengen. */
function withPrf<T extends { extensions?: unknown }>(options: T): T {
	return {
		...options,
		extensions: {
			...((options.extensions as Record<string, unknown> | undefined) ?? {}),
			prf: { eval: { first: PRF_INPUT } }
		}
	} as T;
}

export interface EnrollResult {
	userId: string;
	displayName: string;
	/** Nur bei der Registrierung: einmal anzeigen, danach nie wieder. */
	recoveryPhrase?: string;
	/** Ob der Passkey den Tresor kuenftig allein oeffnen kann. */
	prfAvailable: boolean;
	key: CryptoKey;
}

/** Ein neues Konto anlegen. */
export async function register(
	baseUrl: string,
	displayName: string,
	opts: { invite?: string; email?: string } = {}
): Promise<EnrollResult> {
	const api = new Api({ baseUrl, fetchFn: platformFetch });

	const start = await api.registerStart(displayName, opts.invite);
	const response = await startRegistration({
		optionsJSON: withPrf(start.options as PublicKeyCredentialCreationOptionsJSON)
	});

	const prf = prfOf(response);
	await api.registerFinish({
		challengeId: start.challengeId,
		displayName,
		invite: opts.invite,
		email: opts.email,
		hasPrf: prf !== null,
		response
	});

	// Ab hier ist die Sitzung offen und die Verpackungen koennen abgelegt werden.
	// Die Phrasen-Verpackung IMMER, auch wenn der Passkey PRF kann.
	const key = await createVaultKey();
	const recoveryPhrase = createRecoveryPhrase();
	await api.putWrap("recovery", serialize(await wrapWithPhrase(key, recoveryPhrase)), undefined, {
		recoveryId: await recoveryLookupId(recoveryPhrase),
		vaultProof: await vaultProof(key)
	});
	if (prf) {
		await api.putWrap("passkey", serialize(await wrapWithPrf(key, prf)), response.id);
	}

	return {
		userId: start.userId,
		displayName,
		recoveryPhrase,
		prfAvailable: prf !== null,
		key
	};
}

export interface LoginResult {
	userId: string;
	displayName: string;
	/** Der Tresorschluessel - oder null, wenn er noch entsperrt werden muss. */
	key: CryptoKey | null;
	/** Ob eine Phrasen-Verpackung vorliegt, mit der entsperrt werden kann. */
	canUnlockWithPhrase: boolean;
	/** Was der Authentifikator ueber PRF ausgegeben hat. Null, wenn er es nicht kann. */
	prf: ArrayBuffer | null;
	/** Die Kennung des benutzten Passkeys - an ihr haengt die PRF-Verpackung. */
	credentialId: string;
}

/** Anmelden. */
export async function login(baseUrl: string): Promise<LoginResult> {
	const api = new Api({ baseUrl, fetchFn: platformFetch });
	const start = await api.loginStart();
	const response = await startAuthentication({
		optionsJSON: withPrf(start.options as PublicKeyCredentialRequestOptionsJSON)
	});
	const konto = await api.loginFinish({ challengeId: start.challengeId, response });

	const { wraps } = await api.wraps();
	const prf = prfOf(response);
	const passkeyWrap = wraps.find((w) => w.kind === "passkey" && w.credentialId === response.id);

	let key: CryptoKey | null = null;
	if (prf && passkeyWrap) {
		try {
			key = await unwrapWithPrf(deserialize(passkeyWrap.payload), prf);
		} catch {
			// Der Authentifikator hat einen Wert geliefert, aber nicht den, mit dem
			// verpackt wurde - etwa nach einem Wechsel des Passkey-Verwalters. Dann
			// bleibt die Phrase, statt hier abzubrechen.
			key = null;
		}
	}

	return {
		userId: konto.userId,
		displayName: konto.displayName,
		key,
		canUnlockWithPhrase: wraps.some((w) => w.kind === "recovery"),
		prf,
		credentialId: response.id
	};
}

/** Den Tresor mit der Wiederherstellungs-Phrase oeffnen. */
export async function unlockWithPhrase(baseUrl: string, phrase: string): Promise<CryptoKey> {
	const api = new Api({ baseUrl, fetchFn: platformFetch });
	const { wraps } = await api.wraps();
	const wrap = wraps.find((w) => w.kind === "recovery");
	if (!wrap) throw new Error("Für dieses Konto ist keine Wiederherstellungs-Phrase hinterlegt.");
	return oeffneMitPhrase(wrap.payload, phrase);
}

/** Nach einer Anmeldung ohne PRF-Verpackung: eine anlegen. */
export async function addPasskeyWrap(
	baseUrl: string,
	key: CryptoKey,
	credentialId: string,
	prf: ArrayBuffer
): Promise<void> {
	const api = new Api({ baseUrl, fetchFn: platformFetch });
	await api.putWrap("passkey", serialize(await wrapWithPrf(key, prf)), credentialId);
}

/** Ein Konto allein mit der Wiederherstellungs-Phrase zurueckholen. */
export async function recoverWithPhrase(
	baseUrl: string,
	phrase: string,
	label: string
): Promise<{ userId: string; displayName: string; deviceToken: string; key: CryptoKey }> {
	if (!isValidRecoveryPhrase(phrase)) {
		throw new Error("Das sind nicht 24 gültige Wörter – bitte noch einmal prüfen.");
	}
	const api = new Api({ baseUrl, fetchFn: platformFetch });
	const recoveryId = await recoveryLookupId(phrase);

	const { wrap } = await api.recoverWrap(recoveryId);
	// Hier faellt die Entscheidung: passen die Woerter nicht, geht das Chiffrat
	// nicht auf. Der Server hat damit nichts zu tun und erfaehrt es auch nicht.
	const key = await oeffneMitPhrase(wrap, phrase);

	const angemeldet = await api.recoverDevice({
		recoveryId,
		proof: await vaultProof(key),
		label
	});

	return {
		userId: angemeldet.userId,
		displayName: angemeldet.displayName,
		deviceToken: angemeldet.deviceToken,
		key
	};
}

/**
 * Ein Konto von diesem Geraet aus anlegen - ohne Passkey, fuer die
 * Desktop-Anwendung.
 */
export async function registerFromDevice(
	baseUrl: string,
	/** Leer lassen: dann steht die Kennung des Kontos da. Siehe /api/auth/device. */
	displayName: string,
	label: string,
	opts: { invite?: string; email?: string } = {}
): Promise<{
	userId: string;
	displayName: string;
	deviceToken: string;
	key: CryptoKey;
	recoveryPhrase: string;
}> {
	const api = new Api({ baseUrl, fetchFn: platformFetch });
	const angelegt = await api.registerDevice({
		displayName,
		label,
		invite: opts.invite,
		email: opts.email
	});

	// Ab hier weist sich dieses Geraet mit seinem Token aus - vorher gab es
	// nichts, womit.
	api.setToken(angelegt.deviceToken);

	const key = await createVaultKey();
	const recoveryPhrase = createRecoveryPhrase();
	// Die Phrase zuerst: sie ist der einzige Weg zurueck. Scheitert das, scheitert
	// das Anlegen sichtbar - statt still ein unbrauchbares Konto zu hinterlassen.
	await api.putWrap("recovery", serialize(await wrapWithPhrase(key, recoveryPhrase)), undefined, {
		recoveryId: await recoveryLookupId(recoveryPhrase),
		vaultProof: await vaultProof(key)
	});

	return {
		userId: angelegt.userId,
		displayName: angelegt.displayName,
		deviceToken: angelegt.deviceToken,
		key,
		recoveryPhrase
	};
}

/**
 * Einen WEITEREN Passkey an ein bestehendes Konto haengen.
 *
 *   1. Passkey beim Server hinterlegen - damit meldet er an.
 *   2. Tresorschluessel gegen ihn verpacken - damit oeffnet er die Daten.
 */
export async function addPasskey(
	baseUrl: string,
	key: CryptoKey,
	label: string
): Promise<{ id: string; label: string | null; prfAvailable: boolean }> {
	const api = new Api({ baseUrl, fetchFn: platformFetch });
	const { challengeId, options } = await api.addPasskeyStart();

	const response = await startRegistration({
		optionsJSON: withPrf(options as Parameters<typeof startRegistration>[0]["optionsJSON"])
	});

	const prf = prfOf(response);
	const angelegt = await api.addPasskeyFinish({
		challengeId,
		label,
		hasPrf: prf !== null,
		response
	});

	// Erst jetzt die Verpackung: sie braucht die eben vergebene Kennung.
	if (prf) await api.putWrap("passkey", serialize(await wrapWithPrf(key, prf)), angelegt.id);

	return { id: angelegt.id, label: angelegt.label, prfAvailable: prf !== null };
}

export { ApiError, importVaultKey, toBase64 };
