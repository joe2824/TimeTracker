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
	deserializeWrap,
	fromBase64,
	importVaultKey,
	isValidRecoveryPhrase,
	recoveryLookupId,
	serializeWrap,
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
import { CHALLENGE_REUSE_MS } from "$shared/codes";

/** Was der Server unter einer Verpackung versteht - Format siehe vault.ts. */
const serialize = (wrap: KeyWrap) => JSON.stringify(serializeWrap(wrap));
const deserialize = deserializeWrap;

/** Die Verpackung mit der Phrase oeffnen - oder verstaendlich scheitern. */
async function openWithPhrase(payload: string, phrase: string): Promise<CryptoKey> {
	try {
		return await unwrapWithPhrase(deserialize(payload), phrase);
	} catch {
		throw new Error("Die Wörter passen nicht zu diesem Konto – bitte noch einmal prüfen.");
	}
}

/** Die Verpackung mit dem PRF-Wert oeffnen - oder null, wenn sie nicht aufgeht. */
async function openWithPrf(payload: string, prf: Uint8Array): Promise<CryptoKey | null> {
	try {
		return await unwrapWithPrf(deserialize(payload), prf);
	} catch {
		// Der Authentifikator lieferte einen Wert, aber nicht den, mit dem verpackt
		// wurde - etwa nach einem Wechsel des Passkey-Verwalters. Dann bleibt die
		// Phrase, statt hier abzubrechen.
		return null;
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

type LoginStart = Awaited<ReturnType<Api["loginStart"]>>;
type RegisterStart = Awaited<ReturnType<Api["registerStart"]>>;

const challenges = new Map<string, { at: number; task: Promise<unknown> }>();

/**
 * Eine Aufgabe holen und liegen lassen. Mehrfach aufzurufen kostet nichts -
 * solange eine frische dahaengt, kommt sie zurueck.
 */
function prepare<T>(key: string, start: () => Promise<T>): Promise<T> {
	const waiting = challenges.get(key);
	if (waiting && Date.now() - waiting.at < CHALLENGE_REUSE_MS) return waiting.task as Promise<T>;
	const task = start();
	challenges.set(key, { at: Date.now(), task });
	// Ein Fehlschlag darf sich nicht einbrennen - der naechste Versuch fragt wieder.
	void task.catch(() => forget(key, task));
	return task;
}

/**
 * Eine verbrauchte Aufgabe wegraeumen - der Server loescht sie beim Nachsehen,
 * gleich wie es ausgeht. Nur die eigene: inzwischen kann eine neue dahaengen.
 */
function forget(key: string, task: Promise<unknown>): void {
	if (challenges.get(key)?.task === task) challenges.delete(key);
}

const loginKey = (baseUrl: string) => `login|${baseUrl}`;
const registerKey = (baseUrl: string, displayName: string, invite?: string) =>
	`register|${baseUrl}|${displayName}|${invite ?? ""}`;

/** Die Anmelde-Aufgabe vorladen. */
export function prepareLogin(baseUrl: string): Promise<LoginStart> {
	return prepare(loginKey(baseUrl), () =>
		new Api({ baseUrl, fetchFn: platformFetch }).loginStart()
	);
}

/** Dasselbe fuer das Anlegen eines Kontos. */
export function prepareRegister(
	baseUrl: string,
	displayName = "",
	invite?: string
): Promise<RegisterStart> {
	return prepare(registerKey(baseUrl, displayName, invite), () =>
		new Api({ baseUrl, fetchFn: platformFetch }).registerStart(displayName, invite)
	);
}

export interface EnrollResult {
	userId: string;
	displayName: string;
	/** Nur bei der Registrierung: einmal anzeigen, danach nie wieder. */
	recoveryPhrase?: string;
	/** Ob der Passkey den Vault kuenftig allein oeffnen kann. */
	prfAvailable: boolean;
	/** Die Kennung des eben angelegten Passkeys. */
	credentialId: string;
	key: CryptoKey;
}

/** Ein neues Konto anlegen. */
export async function register(
	baseUrl: string,
	displayName: string,
	opts: { invite?: string; email?: string } = {}
): Promise<EnrollResult> {
	const api = new Api({ baseUrl, fetchFn: platformFetch });

	const task = prepareRegister(baseUrl, displayName, opts.invite);
	const start = await task;
	const response = await startRegistration({
		optionsJSON: withPrf(start.options as PublicKeyCredentialCreationOptionsJSON)
	});

	// Der PRF-Wert kommt beim Anlegen meist nicht heraus - dann holt ihn eine
	// eigene Abfrage nach. Sie laeuft VOR dem Abschluss: der Passkey liegt schon
	// im Authentifikator, und die Antwort wird nirgends geprueft.
	const harvested = prfOf(response)
		? null
		: await harvestPrf(response.id).catch((e) => {
				logWarn("PRF-Wert ließ sich beim Anlegen nicht nachholen", e);
				return { ok: false as const, reason: "noPrf" as const };
			});
	const prf = prfOf(response) ?? (harvested?.ok ? harvested.prf : null);

	// Beide Verpackungen entstehen hier, nicht in einer zweiten Anfrage. Der
	// Server schreibt sie zusammen mit Konto und Passkey in EINER Transaktion -
	// ein Passkey ohne Verpackung kann damit gar nicht erst entstehen.
	const key = await createVaultKey();
	const recoveryPhrase = createRecoveryPhrase();

	try {
		await api.registerFinish({
			challengeId: start.challengeId,
			displayName,
			invite: opts.invite,
			email: opts.email,
			response,
			recoveryWrap: {
				payload: serialize(await wrapWithPhrase(key, recoveryPhrase)),
				recoveryId: await recoveryLookupId(recoveryPhrase),
				vaultProof: await vaultProof(key)
			},
			passkeyWrap: prf ? { payload: serialize(await wrapWithPrf(key, prf)) } : null
		});
	} finally {
		forget(registerKey(baseUrl, displayName, opts.invite), task);
	}

	return {
		prfAvailable: prf !== null,
		credentialId: response.id,
		userId: start.userId,
		displayName,
		recoveryPhrase,
		key
	};
}

/**
 * Warum ein Passkey die Daten nicht oeffnen kann.
 *
 * `otherPasskey`: bestaetigt wurde ein anderer als der gemeinte.
 * `noPrf`: der Authentifikator rechnet keinen PRF-Wert aus - daran aendert auch
 * ein zweiter Versuch nichts, und die Phrase hilft hier ebenfalls nicht: den
 * Wert kann nur der Authentifikator selbst liefern.
 */
export type PrfFailure = "otherPasskey" | "noPrf";

type PrfResult =
	| { ok: true; credentialId: string; prf: Uint8Array }
	| { ok: false; reason: PrfFailure };

/**
 * Den PRF-Wert eines Passkeys per eigener Abfrage holen.
 *
 * Beim Anlegen geben die meisten Browser noch keinen heraus - er faellt erst bei
 * einer Anmeldung an. Eigene Aufgabe statt einer vom Server: die Antwort wird
 * nirgends geprueft, gebraucht wird allein der Wert, den der Authentifikator
 * dazu ausrechnet. Ohne Kennung nimmt der Browser den, den er anbietet.
 */
async function harvestPrf(credentialId?: string): Promise<PrfResult> {
	const options: PublicKeyCredentialRequestOptionsJSON = {
		challenge: toBase64Url(crypto.getRandomValues(new Uint8Array(32))),
		userVerification: "required",
		...(credentialId ? { allowCredentials: [{ id: credentialId, type: "public-key" }] } : {})
	};
	const response = await startAuthentication({ optionsJSON: withPrf(options) });
	// allowCredentials sollte das schon erzwingen - ein Wert vom falschen Passkey
	// wuerde den gemeinten aber nicht reparieren.
	if (credentialId && response.id !== credentialId) return { ok: false, reason: "otherPasskey" };
	const prf = prfOf(response);
	return prf
		? { ok: true, credentialId: response.id, prf }
		: { ok: false, reason: "noPrf" };
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
 * Dafuer sorgen, dass dieser Passkey den Vault allein oeffnen kann.
 *
 * Gibt `false` zurueck, wenn der Authentifikator kein PRF beherrscht - dann
 * bleiben die 24 Woerter oder ein bereits verknuepftes Geraet.
 */
export async function ensurePasskeyWrap(
	api: Api,
	key: CryptoKey,
	/** Nur dieser Passkey zaehlt. Ohne Angabe: der, den der Browser anbietet. */
	credentialId?: string,
	/** Ein bereits vorliegender PRF-Wert - dann entfaellt die zweite Abfrage. */
	prf?: Uint8Array | null
): Promise<{ ok: true; credentialId: string } | { ok: false; reason: PrfFailure }> {
	const found: PrfResult =
		prf && credentialId
			? { ok: true, credentialId, prf }
			: await harvestPrf(credentialId);
	if (!found.ok) return found;
	await api.putWrap("passkey", serialize(await wrapWithPrf(key, found.prf)), found.credentialId);
	return { ok: true, credentialId: found.credentialId };
}

/** Anmelden. */
export async function login(baseUrl: string): Promise<LoginResult> {
	const api = new Api({ baseUrl, fetchFn: platformFetch });
	const task = prepareLogin(baseUrl);
	const start = await task;
	const response = await startAuthentication({
		optionsJSON: withPrf(start.options as PublicKeyCredentialRequestOptionsJSON)
	});
	let account;
	try {
		account = await api.loginFinish({ challengeId: start.challengeId, response });
	} finally {
		forget(loginKey(baseUrl), task);
	}

	const { wraps } = await api.wraps();
	const prf = prfOf(response);
	const passkeyWrap = wraps.find((w) => w.kind === "passkey" && w.credentialId === response.id);
	const key = prf && passkeyWrap ? await openWithPrf(passkeyWrap.payload, prf) : null;

	// Sonst ist nicht zu unterscheiden, ob der PRF-Wert fehlte oder die Verpackung.
	if (!key) {
		logWarn("Passkey öffnete die Daten nicht", {
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

/**
 * Den Vault mit der Wiederherstellungs-Phrase oeffnen.
 *
 * `repair` ist der Passkey, mit dem eben angemeldet wurde: er bekommt dabei die
 * fehlende Verpackung, damit die Phrase wieder das bleibt, wofuer sie gedacht
 * ist - der Weg zurueck, nicht der Weg hinein.
 */
export async function unlockWithPhrase(
	baseUrl: string,
	phrase: string,
	repair?: { credentialId: string; prf: Uint8Array | null }
): Promise<CryptoKey> {
	const api = new Api({ baseUrl, fetchFn: platformFetch });
	const { wraps } = await api.wraps();
	const wrap = wraps.find((w) => w.kind === "recovery");
	if (!wrap) throw new Error("Für dieses Konto ist keine Wiederherstellungs-Phrase hinterlegt.");
	const key = await openWithPhrase(wrap.payload, phrase);
	if (repair) {
		await ensurePasskeyWrap(api, key, repair.credentialId, repair.prf).catch((e) =>
			logWarn("Passkey-Verpackung konnte nicht abgelegt werden", e)
		);
	}
	return key;
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
	const wrapped = await ensurePasskeyWrap(api, key, created.id, prf).catch((e) => {
		logWarn("PRF-Wert konnte nicht nachgeholt werden", e);
		return { ok: false as const, reason: "noPrf" as const };
	});

	return { id: created.id, label: created.label, prfAvailable: wrapped.ok };
}

export { ApiError, importVaultKey, toBase64 };
