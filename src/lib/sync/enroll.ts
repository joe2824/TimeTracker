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
import { logWarn } from "../log";
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
async function openWithPhrase(payload: string, phrase: string): Promise<CryptoKey> {
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

/**
 * Die PRF-Ausgabe in Rohbytes - egal, in welcher Gestalt sie ankommt.
 *
 * `clientExtensionResults` ist eine untypisierte Browser-Schnittstelle: je nach
 * Browser und Bibliothek liegt der Wert als ArrayBuffer, als Ansicht darauf, als
 * base64 oder als durchnummeriertes Objekt vor. Ungeprueft weitergereicht endet
 * das in "Key data must be a BufferSource" - einer Meldung, die nichts darueber
 * sagt, welcher der Werte gemeint ist.
 */
export function prfBytes(first: unknown): Uint8Array | null {
	if (!first) return null;
	if (first instanceof ArrayBuffer) return new Uint8Array(first);
	if (ArrayBuffer.isView(first)) {
		// Auf den Ausschnitt beziehen, nicht auf den ganzen Puffer dahinter: sonst
		// stimmt der Schluessel bei jeder Ansicht mit Versatz nicht mehr.
		const v = first as ArrayBufferView;
		return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
	}
	if (typeof first === "string") return fromBase64(first.replace(/-/g, "+").replace(/_/g, "/"));
	if (typeof first === "object") {
		// Ein ArrayBuffer, der durch structuredClone oder JSON gegangen ist, kommt
		// als {"0":12,"1":250,...} zurueck - oder als leeres Objekt, dann ist er weg.
		const values = Object.values(first as Record<string, unknown>);
		if (values.length > 0 && values.every((w) => typeof w === "number")) {
			return Uint8Array.from(values as number[]);
		}
	}
	throw new Error("Der Passkey lieferte einen PRF-Wert in unbekannter Form.");
}

/** Was ein Authentifikator zurueckgab, sofern er PRF kann. */
function prfOf(response: RegistrationResponseJSON | AuthenticationResponseJSON): Uint8Array | null {
	const ext = response.clientExtensionResults as {
		prf?: { enabled?: boolean; results?: { first?: unknown } };
	};
	return prfBytes(ext?.prf?.results?.first);
}

/** Ob der Authentifikator PRF beherrscht - der Wert kann trotzdem noch fehlen. */
function prfCapable(response: RegistrationResponseJSON | AuthenticationResponseJSON): boolean {
	const ext = response.clientExtensionResults as { prf?: { enabled?: boolean } };
	return ext?.prf?.enabled === true;
}

/** WebAuthn-JSON erwartet base64url, nicht base64. */
function toBase64Url(bytes: Uint8Array): string {
	return toBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
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

// ---------- Die Aufgabe im Voraus holen ----------
//
// WebAuthn will unmittelbar auf die Berührung folgen. Liegt eine langsame
// Verbindung dazwischen - Mobilfunk, gedrosseltes Netz -, ist die Berechtigung
// aus dem Klick abgelaufen, bevor der Dialog aufgehen kann, und der Browser
// lehnt mit NotAllowedError ab. Es sieht aus, als koenne sich niemand mehr
// anmelden. Deshalb wird die Aufgabe schon geholt, wenn jemand auf den Knopf
// zusteuert; der Klick trifft dann auf etwas, das dasteht.

/** Serverseitig gilt eine Aufgabe fuenf Minuten - hier knapp darunter. */
const CHALLENGE_TTL_MS = 4 * 60 * 1000;

type LoginStart = Awaited<ReturnType<Api["loginStart"]>>;
type RegisterStart = Awaited<ReturnType<Api["registerStart"]>>;

interface Prepared<T> {
	/** Adresse und Eingaben, zu denen die Aufgabe passt. */
	key: string;
	at: number;
	task: Promise<T>;
}

let loginPrepared: Prepared<LoginStart> | null = null;
let registerPrepared: Prepared<RegisterStart> | null = null;

function prepared<T>(held: Prepared<T> | null, key: string): Promise<T> | null {
	if (!held || held.key !== key) return null;
	if (Date.now() - held.at > CHALLENGE_TTL_MS) return null;
	return held.task;
}

/**
 * Die Anmelde-Aufgabe vorladen. Mehrfach aufzurufen kostet nichts - solange eine
 * frische daliegt, kommt sie zurueck.
 */
export function prepareLogin(baseUrl: string): Promise<LoginStart> {
	const held = prepared(loginPrepared, baseUrl);
	if (held) return held;
	const task = new Api({ baseUrl, fetchFn: platformFetch }).loginStart();
	loginPrepared = { key: baseUrl, at: Date.now(), task };
	// Ein Fehlschlag darf sich nicht einbrennen - der naechste Versuch fragt wieder.
	void task.catch(() => {
		if (loginPrepared?.task === task) loginPrepared = null;
	});
	return task;
}

/** Dasselbe fuer das Anlegen eines Kontos. */
export function prepareRegister(
	baseUrl: string,
	displayName = "",
	invite?: string
): Promise<RegisterStart> {
	const key = `${baseUrl}|${displayName}|${invite ?? ""}`;
	const held = prepared(registerPrepared, key);
	if (held) return held;
	const task = new Api({ baseUrl, fetchFn: platformFetch }).registerStart(displayName, invite);
	registerPrepared = { key, at: Date.now(), task };
	void task.catch(() => {
		if (registerPrepared?.task === task) registerPrepared = null;
	});
	return task;
}

export interface EnrollResult {
	userId: string;
	displayName: string;
	/** Nur bei der Registrierung: einmal anzeigen, danach nie wieder. */
	recoveryPhrase?: string;
	key: CryptoKey;
}

/** Ein neues Konto anlegen. */
export async function register(
	baseUrl: string,
	displayName: string,
	opts: { invite?: string; email?: string } = {}
): Promise<EnrollResult> {
	const api = new Api({ baseUrl, fetchFn: platformFetch });

	const prepared = prepareRegister(baseUrl, displayName, opts.invite);
	const start = await prepared;
	const response = await startRegistration({
		optionsJSON: withPrf(start.options as PublicKeyCredentialCreationOptionsJSON)
	});

	const prf = prfOf(response);
	try {
		await api.registerFinish({
			challengeId: start.challengeId,
			displayName,
			invite: opts.invite,
			email: opts.email,
			hasPrf: prf !== null,
			response
		});
	} finally {
		// Der Server loescht die Aufgabe beim Nachsehen, gleich wie es ausgeht.
		// Nur die eigene wegraeumen: inzwischen kann eine neue vorgeladen sein.
		if (registerPrepared?.task === prepared) registerPrepared = null;
	}

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
	prf: Uint8Array | null;
	/** Die Kennung des benutzten Passkeys - an ihr haengt die PRF-Verpackung. */
	credentialId: string;
}

/**
 * Die PRF-Verpackung nachholen - fuer Passkeys, die den Wert beim Anlegen nicht
 * herausgaben. Ohne sie verlangt die naechste Anmeldung die 24 Woerter.
 */
export async function harvestPrfWrap(
	api: Api,
	key: CryptoKey,
	/** Nur dieser Passkey zaehlt. Ohne Angabe: der, den der Browser anbietet. */
	credentialId?: string
): Promise<boolean> {
	// Eigene Aufgabe statt einer vom Server: die Antwort wird nirgends geprueft,
	// gebraucht wird allein der PRF-Wert, den der Authentifikator dazu ausrechnet.
	const options: PublicKeyCredentialRequestOptionsJSON = {
		challenge: toBase64Url(crypto.getRandomValues(new Uint8Array(32))),
		userVerification: "required",
		...(credentialId ? { allowCredentials: [{ id: credentialId, type: "public-key" }] } : {})
	};
	const response = await startAuthentication({ optionsJSON: withPrf(options) });
	// allowCredentials sollte das schon erzwingen - ein Wert vom falschen Passkey
	// wuerde den gemeinten aber nicht reparieren.
	if (credentialId && response.id !== credentialId) return false;
	const prf = prfOf(response);
	if (!prf) return false;
	await api.putWrap("passkey", serialize(await wrapWithPrf(key, prf)), response.id);
	return true;
}

/** Anmelden. */
export async function login(baseUrl: string): Promise<LoginResult> {
	const api = new Api({ baseUrl, fetchFn: platformFetch });
	const prepared = prepareLogin(baseUrl);
	const start = await prepared;
	const response = await startAuthentication({
		optionsJSON: withPrf(start.options as PublicKeyCredentialRequestOptionsJSON)
	});
	let account;
	try {
		account = await api.loginFinish({ challengeId: start.challengeId, response });
	} finally {
		// Der Server loescht die Aufgabe beim Nachsehen, gleich wie es ausgeht.
		// Nur die eigene wegraeumen: inzwischen kann eine neue vorgeladen sein.
		if (loginPrepared?.task === prepared) loginPrepared = null;
	}

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

	// Sonst ist nicht zu unterscheiden, ob der PRF-Wert fehlte oder die Verpackung.
	if (!key) {
		logWarn("Passkey öffnete den Tresor nicht", {
			prf: prf !== null,
			wrap: passkeyWrap !== undefined
		});
	}

	return {
		userId: account.userId,
		displayName: account.displayName,
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
	return openWithPhrase(wrap.payload, phrase);
}

/** Nach einer Anmeldung ohne PRF-Verpackung: eine anlegen. */
export async function addPasskeyWrap(
	baseUrl: string,
	key: CryptoKey,
	credentialId: string,
	prf: BufferSource
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
	const key = await openWithPhrase(wrap, phrase);

	const loggedIn = await api.recoverDevice({
		recoveryId,
		proof: await vaultProof(key),
		label
	});

	return {
		userId: loggedIn.userId,
		displayName: loggedIn.displayName,
		deviceToken: loggedIn.deviceToken,
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
	const created = await api.registerDevice({
		displayName,
		label,
		invite: opts.invite,
		email: opts.email
	});

	// Ab hier weist sich dieses Geraet mit seinem Token aus - vorher gab es
	// nichts, womit.
	api.setToken(created.deviceToken);

	const key = await createVaultKey();
	const recoveryPhrase = createRecoveryPhrase();
	// Die Phrase zuerst: sie ist der einzige Weg zurueck. Scheitert das, scheitert
	// das Anlegen sichtbar - statt still ein unbrauchbares Konto zu hinterlassen.
	await api.putWrap("recovery", serialize(await wrapWithPhrase(key, recoveryPhrase)), undefined, {
		recoveryId: await recoveryLookupId(recoveryPhrase),
		vaultProof: await vaultProof(key)
	});

	return {
		userId: created.userId,
		displayName: created.displayName,
		deviceToken: created.deviceToken,
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
	api: Api,
	key: CryptoKey,
	label: string
): Promise<{ id: string; label: string | null; prfAvailable: boolean }> {
	// Die Api des Kontos, keine frisch gebaute: nach einer Anmeldung mit der
	// Phrase weist dieses Geraet sich mit seinem Token aus, nicht mit einem
	// Cookie. Eine Api ohne Token liefe dort in "Nicht angemeldet".
	const { challengeId, options } = await api.addPasskeyStart();

	const response = await startRegistration({
		optionsJSON: withPrf(options as Parameters<typeof startRegistration>[0]["optionsJSON"])
	});

	const prf = prfOf(response);
	const created = await api.addPasskeyFinish({
		challengeId,
		label,
		hasPrf: prf !== null,
		response
	});

	// Erst jetzt die Verpackung: sie braucht die eben vergebene Kennung.
	let prfOk = prf !== null;
	if (prf) {
		await api.putWrap("passkey", serialize(await wrapWithPrf(key, prf)), created.id);
	} else if (prfCapable(response)) {
		prfOk = await harvestPrfWrap(api, key, created.id).catch((e) => {
			logWarn("PRF-Wert konnte nicht nachgeholt werden", e);
			return false;
		});
	}

	return { id: created.id, label: created.label, prfAvailable: prfOk };
}

export { ApiError, importVaultKey, toBase64 };
