// Der Vault-Schluessel und alles, was mit ihm geschieht.
//
// Verpackt wird als JWE (RFC 7516/7518, ueber die Bibliothek `jose`): die drei
// Verpackungswege unten bilden fast 1:1 auf JWE-Standardalgorithmen ab
// (PBES2 fuer die Phrase, ECDH-ES fuer die Kopplung inklusive automatischer
// Ephemeral-Key-Verwaltung im `epk`-Header).

import { generateMnemonic, mnemonicToEntropy, validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import { CompactEncrypt, compactDecrypt, decodeProtectedHeader } from "jose";
import {
	CODE_ALPHABET,
	PAIRING_CODE_LENGTH,
	isPairingCode,
	normalizePairingCode
} from "$shared/codes";

const enc = new TextEncoder();

/** Laenge des Vault-Schluessels in Bit. */
const KEY_BITS = 256;
/** Iterationen fuer die Phrase - grosszuegig, aber nicht entscheidend (siehe unten). */
const PBES2_ITERATIONS = 600_000;
/** Alle drei Verpackungswege verschluesseln denselben Inhalt (den Vault-Schluessel) gleich. */
const WRAP_ENC = "A256GCM";

// ---------- Vault-Schluessel ----------

/**
 * Der Vault-Schluessel - zwei Schluessel aus demselben Geheimnis, je einer fuer
 * seinen Zweck.
 *
 * Getrennt, weil ein `CryptoKey` immer zu genau einem Algorithmus gehoert: die
 * abgeleiteten Kennungen (`bucketFor`, `vaultProof`) sind HMAC, das Ver- und
 * Entschluesseln ist AES-GCM. Beide hier zusammenzuhalten ist das, was die
 * abgelegte Kopie ueberhaupt brauchbar macht - sonst muesste fuer jede Kennung
 * erst wieder exportiert werden, und genau das schlaegt fuer eine
 * nicht-exportierbare Kopie fehl (siehe `platform/keyStore.ts`).
 */
export interface VaultKey {
	/** Datensaetze und lokale Dateien. */
	enc: CryptoKey;
	/** Abgeleitete Kennungen. Gibt seine Bytes nie heraus - er muss es nie. */
	mac: CryptoKey;
}

async function vaultKeyFromRaw(raw: BufferSource, extractable: boolean): Promise<VaultKey> {
	const [enc, mac] = await Promise.all([
		crypto.subtle.importKey("raw", raw, "AES-GCM", extractable, ["encrypt", "decrypt"]),
		crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign"])
	]);
	return { enc, mac };
}

/** Einen neuen, zufaelligen Vault-Schluessel erzeugen. */
export async function createVaultKey(): Promise<VaultKey> {
	return vaultKeyFromRaw(crypto.getRandomValues(new Uint8Array(KEY_BITS / 8)), true);
}

/**
 * Rohbytes zu einem Vault-Schluessel machen.
 *
 * `extractable: false` fuer eine Kopie, die nur noch ver-/entschluesseln und
 * Kennungen rechnen kann, nie wieder Bytes herausgibt - siehe
 * `platform/keyStore.ts`. Fuer die laufende Sitzung bleibt es bei `true`
 * (Vorgabe): eine neue Passkey-/Geraete-Verpackung braucht die Bytes.
 */
export async function importVaultKey(raw: ArrayBuffer, extractable = true): Promise<VaultKey> {
	return vaultKeyFromRaw(raw, extractable);
}

export async function exportVaultKey(key: VaultKey): Promise<ArrayBuffer> {
	return crypto.subtle.exportKey("raw", key.enc);
}

/**
 * Ob dieser Schluessel seine Bytes noch herausgibt.
 *
 * Nur eine NEUE Verpackung braucht sie (Passkey anlegen, Geraet koppeln) -
 * lesen, schreiben und abgleichen kommen ohne aus. Wer verpacken will, fragt
 * vorher hier, statt in einen `InvalidAccessError` zu laufen.
 */
export function isExportable(key: VaultKey): boolean {
	return key.enc.extractable;
}

// ---------- Datensaetze ----------

/** Woran ein Chiffrat gebunden ist - als JWE-Header-Claims mitversiegelt. */
export interface RecordBinding {
	id: string;
	kind: string;
	rev: number;
}

interface RecordHeader {
	recId: string;
	recKind: string;
	recRev: number;
}

/** Wie eine Verpackung des Vault-Schluessels entstanden ist. */
export type WrapKind = "recovery" | "passkey" | "device";

/**
 * Einen Datensatz verschluesseln - `alg:"dir"`, der Vault-Schluessel wird
 * direkt als Inhaltsschluessel benutzt. `binding` liegt als Header-Claims im
 * JWE und ist damit Teil der authentisierten Daten: eine vertauschte Datei
 * (falscher Monat, falsche Kennung) faellt beim Oeffnen auf.
 */
export async function sealRecord(
	key: VaultKey,
	value: unknown,
	binding: RecordBinding
): Promise<string> {
	const plaintext = enc.encode(JSON.stringify(value));
	const header: RecordHeader = { recId: binding.id, recKind: binding.kind, recRev: binding.rev };
	return new CompactEncrypt(plaintext)
		.setProtectedHeader({ alg: "dir", enc: WRAP_ENC, ...header })
		.encrypt(key.enc);
}

/** Einen Datensatz entschluesseln. Wirft, wenn Chiffrat, Bindung oder Schluessel nicht passen. */
export async function openRecord<T>(
	key: VaultKey,
	sealed: string,
	binding: RecordBinding
): Promise<T> {
	const { plaintext, protectedHeader } = await compactDecrypt(sealed, key.enc, {
		keyManagementAlgorithms: ["dir"],
		contentEncryptionAlgorithms: [WRAP_ENC]
	});
	const header = protectedHeader as unknown as RecordHeader;
	if (
		header.recId !== binding.id ||
		header.recKind !== binding.kind ||
		header.recRev !== binding.rev
	) {
		throw new Error("Datensatz passt nicht zur erwarteten Kennung.");
	}
	return JSON.parse(new TextDecoder().decode(plaintext)) as T;
}

// ---------- Abgeleitete Werte ----------

/** Ein fester Wert aus dem Vault-Schluessel, je Verwendungszweck ein anderer. */
async function hmacWithVaultKey(key: VaultKey, message: string): Promise<Uint8Array> {
	return new Uint8Array(await crypto.subtle.sign("HMAC", key.mac, enc.encode(message)));
}

// ---------- Zeitraum-Kennung ----------

/** Die verschleierte Kennung eines Monats. */
export async function bucketFor(key: VaultKey, month: string): Promise<string> {
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

/** Ein Nachweis, dass jemand den Vault-Schluessel wirklich hat. */
export async function vaultProof(key: VaultKey): Promise<string> {
	return toHex(await hmacWithVaultKey(key, "vault-proof-v1"));
}

// ---------- Verpackung des Vault-Schluessels: gemeinsamer Kern ----------
//
// Alle drei Wege (Phrase, Passkey-PRF, Geraete-Kopplung) verschluesseln
// denselben Inhalt (den exportierten Vault-Schluessel) auf dieselbe Art -
// nur der JWE-Header und der Schluessel/das Geheimnis, mit dem verpackt wird,
// unterscheiden sich. Ein Fund im Ver-/Entpacken selbst (z.B. an `.buffer`,
// siehe unten) muss so nur an einer Stelle stimmen, nicht an dreien.

/** Grundform aller drei Ver-/Entpackwege - `wrap*`/`unwrap*` liefern nur noch Header, Schluessel, Algorithmen. */
async function wrapVaultKey(
	vaultKey: VaultKey,
	header: { alg: string; [claim: string]: unknown },
	key: Parameters<InstanceType<typeof CompactEncrypt>["encrypt"]>[0],
	keyManagementParameters?: Parameters<
		InstanceType<typeof CompactEncrypt>["setKeyManagementParameters"]
	>[0]
): Promise<string> {
	const raw = new Uint8Array(await exportVaultKey(vaultKey));
	const jwe = new CompactEncrypt(raw).setProtectedHeader({ ...header, enc: WRAP_ENC } as never);
	if (keyManagementParameters) jwe.setKeyManagementParameters(keyManagementParameters);
	return jwe.encrypt(key);
}

async function unwrapVaultKey(
	wrap: string,
	key: Parameters<typeof compactDecrypt>[1],
	keyManagementAlgorithms: string[],
	decryptOptions: Partial<Parameters<typeof compactDecrypt>[2]> = {}
): Promise<VaultKey> {
	const { plaintext } = await compactDecrypt(wrap, key, {
		keyManagementAlgorithms: keyManagementAlgorithms as never,
		contentEncryptionAlgorithms: [WRAP_ENC],
		...decryptOptions
	});
	return importVaultKey(plaintext.buffer as ArrayBuffer);
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

/**
 * Die Phrase verpackt den Vault-Schluessel - `PBES2-HS512+A256KW`, das
 * Passwort ist die Entropie der Phrase, nicht ihr Text (derselbe Schluessel
 * auch dann, wenn jemand sie in einer anderen Schreibweise eingibt). Salz und
 * Iterationszahl liegen automatisch im JWE-Header, `p2c` explizit gesetzt.
 */
export async function wrapWithPhrase(vaultKey: VaultKey, phrase: string): Promise<string> {
	const entropy = mnemonicToEntropy(normalizePhrase(phrase), wordlist);
	return wrapVaultKey(vaultKey, { alg: "PBES2-HS512+A256KW" }, entropy as Uint8Array, {
		p2c: PBES2_ITERATIONS
	});
}

export async function unwrapWithPhrase(wrap: string, phrase: string): Promise<VaultKey> {
	const entropy = mnemonicToEntropy(normalizePhrase(phrase), wordlist);
	return unwrapVaultKey(wrap, entropy as Uint8Array, ["PBES2-HS512+A256KW"], {
		maxPBES2Count: PBES2_ITERATIONS
	});
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
		["encrypt", "decrypt", "wrapKey", "unwrapKey"]
	);
}

/**
 * Der PRF-Wert selbst ist kein Standard-JWE-Schluessel (kein Passwort, kein
 * EC-Schluessel) - `kekFromPrf` leitet erst einen ab (HKDF, wie bisher), der
 * dann als `A256GCMKW`-Schluessel den Vault-Schluessel verpackt. Das
 * HKDF-Salz reist als eigenes Header-Claim mit, da JWE dafuer kein Feld kennt.
 */
export async function wrapWithPrf(vaultKey: VaultKey, prfOutput: BufferSource): Promise<string> {
	const salt = crypto.getRandomValues(new Uint8Array(16));
	const kek = await kekFromPrf(prfOutput, salt);
	return wrapVaultKey(vaultKey, { alg: "A256GCMKW", prfSalt: toBase64(salt) }, kek);
}

export async function unwrapWithPrf(wrap: string, prfOutput: BufferSource): Promise<VaultKey> {
	const header = decodeProtectedHeader(wrap) as { prfSalt?: string };
	if (!header.prfSalt) throw new Error("Passkey-Verpackung ohne Salz.");
	const kek = await kekFromPrf(prfOutput, fromBase64(header.prfSalt));
	return unwrapVaultKey(wrap, kek, ["A256GCMKW"]);
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

/**
 * Auf dem entsperrten Geraet: den Vault-Schluessel fuer das neue Geraet
 * verpacken - `ECDH-ES+A256KW`. `jose` erzeugt das fluechtige Schluesselpaar
 * selbst, macht ECDH+ConcatKDF und AES-Key-Wrap, und legt den oeffentlichen
 * fluechtigen Schluessel automatisch ins Standard-Header-Feld `epk` - nichts
 * davon muss hier noch von Hand mitgefuehrt werden.
 */
export async function wrapForDevice(
	vaultKey: VaultKey,
	targetPublicKey: Uint8Array
): Promise<string> {
	const peer = await crypto.subtle.importKey(
		"raw",
		targetPublicKey as BufferSource,
		{ name: "ECDH", namedCurve: "P-256" },
		true,
		[]
	);
	return wrapVaultKey(vaultKey, { alg: "ECDH-ES+A256KW" }, peer);
}

/** Auf dem neuen Geraet: das Paket mit dem eigenen privaten Schluessel oeffnen. */
export async function unwrapForDevice(wrap: string, ownPrivateKey: CryptoKey): Promise<VaultKey> {
	return unwrapVaultKey(wrap, ownPrivateKey, ["ECDH-ES+A256KW"]);
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
