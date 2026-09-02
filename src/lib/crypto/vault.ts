// Der Tresorschluessel und alles, was mit ihm geschieht.

import { generateMnemonic, mnemonicToEntropy, validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import {
	CODE_ALPHABET,
	PAIRING_CODE_LENGTH,
	isPairingCode,
	normalizePairingCode
} from "$shared/codes";

const enc = new TextEncoder();

/** Laenge des Tresorschluessels in Bit. */
const KEY_BITS = 256;
/** GCM will 96 Bit Zufall je Vorgang - laenger bringt nichts, kuerzer schadet. */
const IV_BYTES = 12;
/** Iterationen fuer die Phrase - grosszuegig, aber nicht entscheidend (siehe oben). */
const PBKDF2_ITERATIONS = 600_000;

// ---------- Tresorschluessel ----------

/** Einen neuen, zufaelligen Tresorschluessel erzeugen. */
export async function createVaultKey(): Promise<CryptoKey> {
	return crypto.subtle.generateKey({ name: "AES-GCM", length: KEY_BITS }, true, [
		"encrypt",
		"decrypt"
	]);
}

/** Rohbytes zu einem Tresorschluessel machen. */
export async function importVaultKey(raw: ArrayBuffer): Promise<CryptoKey> {
	return crypto.subtle.importKey("raw", raw, "AES-GCM", true, ["encrypt", "decrypt"]);
}

export async function exportVaultKey(key: CryptoKey): Promise<ArrayBuffer> {
	return crypto.subtle.exportKey("raw", key);
}

// ---------- Datensaetze ----------

/** Woran ein Chiffrat gebunden ist - als "zusaetzliche Daten" mitversiegelt. */
export interface RecordBinding {
	id: string;
	kind: string;
	rev: number;
}

export interface Sealed {
	iv: Uint8Array;
	ciphertext: Uint8Array;
}

function bindingBytes(b: RecordBinding): Uint8Array {
	return enc.encode(`${b.kind}|${b.id}|${b.rev}`);
}

/** Einen Datensatz verschluesseln. */
export async function sealRecord(
	key: CryptoKey,
	value: unknown,
	binding: RecordBinding
): Promise<Sealed> {
	const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
	const data = enc.encode(JSON.stringify(value));
	const ciphertext = await crypto.subtle.encrypt(
		{ name: "AES-GCM", iv, additionalData: bindingBytes(binding) },
		key,
		data
	);
	return { iv, ciphertext: new Uint8Array(ciphertext) };
}

/** Einen Datensatz entschluesseln. Wirft, wenn Chiffrat oder Bindung nicht passen. */
export async function openRecord<T>(
	key: CryptoKey,
	sealed: Sealed,
	binding: RecordBinding
): Promise<T> {
	const plain = await crypto.subtle.decrypt(
		{ name: "AES-GCM", iv: sealed.iv, additionalData: bindingBytes(binding) },
		key,
		sealed.ciphertext
	);
	return JSON.parse(new TextDecoder().decode(plain)) as T;
}

// ---------- Abgeleitete Werte ----------

/** Ein fester Wert aus dem Tresorschluessel, je Verwendungszweck ein anderer. */
async function hmacWithVaultKey(key: CryptoKey, message: string): Promise<Uint8Array> {
	const raw = await crypto.subtle.exportKey("raw", key);
	const mac = await crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, [
		"sign"
	]);
	return new Uint8Array(await crypto.subtle.sign("HMAC", mac, enc.encode(message)));
}

// ---------- Zeitraum-Kennung ----------

/** Die verschleierte Kennung eines Monats. */
export async function bucketFor(key: CryptoKey, month: string): Promise<string> {
	// 16 Byte reichen: die Kennung muss eindeutig sein, nicht faelschungssicher -
	// wer sie faelscht, bekommt Chiffrate, die er nicht oeffnen kann.
	return toHex((await hmacWithVaultKey(key, `bucket|${month}`)).slice(0, 16));
}

/** Die Kennung, unter der ein Konto seine Phrasen-Verpackung findet. */
export async function recoveryLookupId(phrase: string): Promise<string> {
	const entropy = mnemonicToEntropy(normalizePhrase(phrase), wordlist);
	const base = await crypto.subtle.importKey("raw", entropy as BufferSource, "HKDF", false, [
		"deriveBits"
	]);
	const bits = await crypto.subtle.deriveBits(
		{
			name: "HKDF",
			hash: "SHA-256",
			salt: enc.encode("timetracker-recovery-lookup-v1"),
			info: enc.encode("lookup")
		},
		base,
		256
	);
	return toHex(new Uint8Array(bits));
}

/** Ein Nachweis, dass jemand den Tresorschluessel wirklich hat. */
export async function vaultProof(key: CryptoKey): Promise<string> {
	return toHex(await hmacWithVaultKey(key, "vault-proof-v1"));
}

// ---------- Verpackungen ----------

export type WrapKind = "recovery" | "passkey" | "device";

export interface KeyWrap {
	kind: WrapKind;
	/** Womit die Verpackung geoeffnet wird - Zufall je Verpackung. */
	salt: Uint8Array;
	iv: Uint8Array;
	wrapped: Uint8Array;
	/** Nur bei "device": der fluechtige oeffentliche Schluessel des Verpackenden. */
	ephemeralPublicKey?: Uint8Array;
}

async function wrapWith(
	kek: CryptoKey,
	vaultKey: CryptoKey,
	salt: Uint8Array,
	kind: WrapKind
): Promise<KeyWrap> {
	const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
	const raw = await exportVaultKey(vaultKey);
	const wrapped = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, kek, raw);
	return { kind, salt, iv, wrapped: new Uint8Array(wrapped) };
}

async function unwrapWith(kek: CryptoKey, wrap: KeyWrap): Promise<CryptoKey> {
	const raw = await crypto.subtle.decrypt({ name: "AES-GCM", iv: wrap.iv }, kek, wrap.wrapped);
	return importVaultKey(raw);
}

// ---------- Verpackung aus der Wiederherstellungs-Phrase ----------

/** Eine neue Wiederherstellungs-Phrase: 24 Woerter, 256 Bit Entropie. */
export function createRecoveryPhrase(): string {
	return generateMnemonic(wordlist, KEY_BITS);
}

export function isValidRecoveryPhrase(phrase: string): boolean {
	return validateMnemonic(normalizePhrase(phrase), wordlist);
}

/** Schreibweise vereinheitlichen: Grossbuchstaben, doppelte Leerzeichen, Umbrueche. */
export function normalizePhrase(phrase: string): string {
	return phrase.trim().toLowerCase().split(/\s+/).join(" ");
}

async function kekFromPhrase(phrase: string, salt: Uint8Array): Promise<CryptoKey> {
	// Die Entropie der Phrase, nicht ihr Text: derselbe Schluessel auch dann, wenn
	// jemand sie in einer anderen Schreibweise eingibt.
	const entropy = mnemonicToEntropy(normalizePhrase(phrase), wordlist);
	const base = await crypto.subtle.importKey("raw", entropy as BufferSource, "PBKDF2", false, [
		"deriveKey"
	]);
	return crypto.subtle.deriveKey(
		{
			name: "PBKDF2",
			salt: salt as BufferSource,
			iterations: PBKDF2_ITERATIONS,
			hash: "SHA-256"
		},
		base,
		{ name: "AES-GCM", length: KEY_BITS },
		false,
		["encrypt", "decrypt"]
	);
}

export async function wrapWithPhrase(vaultKey: CryptoKey, phrase: string): Promise<KeyWrap> {
	const salt = crypto.getRandomValues(new Uint8Array(16));
	return wrapWith(await kekFromPhrase(phrase, salt), vaultKey, salt, "recovery");
}

export async function unwrapWithPhrase(wrap: KeyWrap, phrase: string): Promise<CryptoKey> {
	return unwrapWith(await kekFromPhrase(phrase, wrap.salt), wrap);
}

// ---------- Verpackung aus einem Passkey (PRF) ----------

/** Den Verpackungs-Schluessel aus der PRF-Erweiterung eines Passkeys ableiten. */
export async function kekFromPrf(prfOutput: BufferSource, salt: Uint8Array): Promise<CryptoKey> {
	const base = await crypto.subtle.importKey("raw", prfOutput, "HKDF", false, ["deriveKey"]);
	return crypto.subtle.deriveKey(
		{
			name: "HKDF",
			hash: "SHA-256",
			salt: salt as BufferSource,
			info: enc.encode("timetracker-vault")
		},
		base,
		{ name: "AES-GCM", length: KEY_BITS },
		false,
		["encrypt", "decrypt"]
	);
}

export async function wrapWithPrf(vaultKey: CryptoKey, prfOutput: BufferSource): Promise<KeyWrap> {
	const salt = crypto.getRandomValues(new Uint8Array(16));
	return wrapWith(await kekFromPrf(prfOutput, salt), vaultKey, salt, "passkey");
}

export async function unwrapWithPrf(wrap: KeyWrap, prfOutput: BufferSource): Promise<CryptoKey> {
	return unwrapWith(await kekFromPrf(prfOutput, wrap.salt), wrap);
}

// ---------- Verpackung fuer ein neues Geraet ----------

/** Das fluechtige Schluesselpaar des neuen Geraets beim Koppeln. */
export async function createPairingKeyPair(): Promise<CryptoKeyPair> {
	return crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
		"deriveBits"
	]) as Promise<CryptoKeyPair>;
}

export async function exportPairingPublicKey(pair: CryptoKeyPair): Promise<Uint8Array> {
	return new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
}

async function kekFromEcdh(
	privateKey: CryptoKey,
	peerPublicKey: Uint8Array,
	salt: Uint8Array
): Promise<CryptoKey> {
	const peer = await crypto.subtle.importKey(
		"raw",
		peerPublicKey as BufferSource,
		{ name: "ECDH", namedCurve: "P-256" },
		false,
		[]
	);
	const shared = await crypto.subtle.deriveBits({ name: "ECDH", public: peer }, privateKey, 256);
	const base = await crypto.subtle.importKey("raw", shared, "HKDF", false, ["deriveKey"]);
	return crypto.subtle.deriveKey(
		{
			name: "HKDF",
			hash: "SHA-256",
			salt: salt as BufferSource,
			info: enc.encode("timetracker-pairing")
		},
		base,
		{ name: "AES-GCM", length: KEY_BITS },
		false,
		["encrypt", "decrypt"]
	);
}

// ---------- Der Kopplungscode ----------
//
// Alphabet, Laenge und Form stehen in shared/codes.ts. Der Server prueft
// dieselbe Form; zwei Fassungen davon waeren zwei Gelegenheiten fuer einen Code,
// den die eine Seite annimmt und die andere nicht.
export { isPairingCode, normalizePairingCode };

/** Der Kopplungscode zu einem oeffentlichen Schluessel - dessen Abdruck. */
export async function pairingCode(publicKey: Uint8Array): Promise<string> {
	const imprint = new Uint8Array(
		await crypto.subtle.digest("SHA-256", publicKey as BufferSource)
	);
	let out = "";
	for (let i = 0; i < PAIRING_CODE_LENGTH; i++) {
		// Fuenf Bit je Stelle, fortlaufend aus dem Abdruck gelesen. Zwei Bytes auf
		// einmal, weil eine Stelle ueber eine Byte-Grenze reichen kann.
		const bit = i * 5;
		const byte = bit >> 3;
		const offset = bit & 7;
		const window = (imprint[byte] << 8) | imprint[byte + 1];
		out += CODE_ALPHABET[(window >> (11 - offset)) & 31];
	}
	return out;
}

/**
 * Das Abhol-Geheimnis und sein Hash.
 *
 * Der Kopplungscode ist der Abdruck des Geraeteschluessels und muss sichtbar
 * sein - ein Mensch soll ihn vergleichen. Als Ausweis beim Abholen taugt er
 * damit nicht: wer ihn mitliest, holte sonst das Geraete-Token ab. Das
 * Geheimnis bleibt deshalb hier im Speicher, zum Server geht nur sein Hash.
 *
 * Gehasht wird die ZEICHENKETTE, nicht die Bytes dahinter - der Server rechnet
 * mit `createHash("sha256").update(secret)` genauso.
 */
export async function createClaimSecret(): Promise<{ secret: string; hash: string }> {
	const secret = toBase64(crypto.getRandomValues(new Uint8Array(32)));
	return { secret, hash: await sha256Hex(secret) };
}

/** SHA-256 einer Zeichenkette, hexadezimal - die Form, in der der Server ablegt. */
export async function sha256Hex(text: string): Promise<string> {
	const raw = new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(text)));
	return [...raw].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Der hinterlegte Schluessel - aber nur, wenn er zu diesem Code gehoert. */
export async function checkedPairingKey(code: string, publicKeyBase64: string): Promise<Uint8Array> {
	const raw = fromBase64(publicKeyBase64);
	if ((await pairingCode(raw)) !== normalizePairingCode(code)) {
		throw new Error(
			"Der hinterlegte Schlüssel passt nicht zu diesem Code. Die Kopplung wurde abgebrochen – bitte auf dem neuen Gerät einen neuen Code anzeigen lassen."
		);
	}
	return raw;
}

/** Fuer die Anzeige: Vierergruppen, wie beim Einladungscode. */
export function formatPairingCode(code: string): string {
	return (code.match(/.{1,4}/g) ?? [code]).join("-");
}

/** Auf dem entsperrten Geraet: den Tresorschluessel fuer das neue Geraet verpacken. */
export async function wrapForDevice(
	vaultKey: CryptoKey,
	targetPublicKey: Uint8Array
): Promise<KeyWrap> {
	const ephemeral = await createPairingKeyPair();
	const salt = crypto.getRandomValues(new Uint8Array(16));
	const kek = await kekFromEcdh(ephemeral.privateKey, targetPublicKey, salt);
	const wrap = await wrapWith(kek, vaultKey, salt, "device");
	wrap.ephemeralPublicKey = await exportPairingPublicKey(ephemeral);
	return wrap;
}

/** Auf dem neuen Geraet: das Paket mit dem eigenen privaten Schluessel oeffnen. */
export async function unwrapForDevice(wrap: KeyWrap, ownPrivateKey: CryptoKey): Promise<CryptoKey> {
	if (!wrap.ephemeralPublicKey) throw new Error("Kopplungspaket ohne öffentlichen Schlüssel");
	return unwrapWith(await kekFromEcdh(ownPrivateKey, wrap.ephemeralPublicKey, wrap.salt), wrap);
}

// ---------- Hilfen ----------

export function toHex(bytes: Uint8Array): string {
	return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function fromHex(hex: string): Uint8Array {
	const out = new Uint8Array(hex.length / 2);
	for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
	return out;
}

/** Base64 fuer den Transport - die Datensaetze reisen als JSON. */
export function toBase64(bytes: Uint8Array): string {
	let s = "";
	for (const b of bytes) s += String.fromCharCode(b);
	return btoa(s);
}

export function fromBase64(b64: string): Uint8Array {
	const s = atob(b64);
	const out = new Uint8Array(s.length);
	for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
	return out;
}

// ---------- Wire-Format einer Verpackung ----------
//
// So legt der Server sie ab, und so reist sie durch die Kopplung: JSON mit
// base64-Feldern. Stand an drei Stellen; drei Fassungen hiessen, dass ein
// zusaetzliches Feld nur an zweien ankommt.

/** Eine Verpackung als JSON-Objekt - Bytes werden zu base64. */
export function serializeWrap(wrap: KeyWrap): Record<string, string> {
	return {
		kind: wrap.kind,
		salt: toBase64(wrap.salt),
		iv: toBase64(wrap.iv),
		wrapped: toBase64(wrap.wrapped),
		...(wrap.ephemeralPublicKey ? { ephemeralPublicKey: toBase64(wrap.ephemeralPublicKey) } : {})
	};
}

/** Der Weg zurueck. `kind` faellt vor, wo es im JSON fehlt (Kopplung). */
export function deserializeWrap(payload: string, kind: KeyWrap["kind"] = "device"): KeyWrap {
	const d = JSON.parse(payload);
	return {
		kind: d.kind ?? kind,
		salt: fromBase64(d.salt),
		iv: fromBase64(d.iv),
		wrapped: fromBase64(d.wrapped),
		...(d.ephemeralPublicKey ? { ephemeralPublicKey: fromBase64(d.ephemeralPublicKey) } : {})
	};
}
