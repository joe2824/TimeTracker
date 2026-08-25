// Der Tresorschluessel und alles, was mit ihm geschieht.
//
// Grundgedanke: es gibt genau EINEN zufaelligen Schluessel je Konto - den
// Tresorschluessel. Er verschluesselt jeden Datensatz und verlaesst nie ein
// Geraet im Klartext. Zugaenglich wird er ueber "Verpackungen": derselbe
// Schluessel, mehrfach verschluesselt abgelegt, jeweils mit einem anderen
// Oeffner.
//
//   Tresorschluessel (256 bit)
//     |- Verpackung "recovery" : aus der Wiederherstellungs-Phrase
//     |- Verpackung "passkey"  : aus der PRF-Erweiterung eines Passkeys
//     |- Verpackung "device"   : fuer den oeffentlichen Schluessel eines Geraets
//
// Der Server speichert die Verpackungen, kann sie aber nicht oeffnen: er sieht
// nur Chiffrat. Genau deshalb kann er auch keine Auswertung rechnen - und genau
// deshalb muss er es auch nicht.
//
// Warum kein Argon2 fuer die Phrase: die Phrase hat 256 Bit Entropie. Ein
// Verfahren, das Rateversuche teurer macht, schuetzt eine SCHWACHE Eingabe. Bei
// 24 zufaelligen Woertern ist Raten ohnehin ausgeschlossen, und PBKDF2 gibt es
// in jeder Laufzeit ohne zusaetzliches WebAssembly.

import { generateMnemonic, mnemonicToEntropy, validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";

const enc = new TextEncoder();

/** Laenge des Tresorschluessels in Bit. */
const KEY_BITS = 256;
/** GCM will 96 Bit Zufall je Vorgang - laenger bringt nichts, kuerzer schadet. */
const IV_BYTES = 12;
/**
 * Iterationen fuer die Phrase.
 *
 * Grosszuegig, aber nicht entscheidend - siehe oben: die Phrase ist stark genug,
 * dass hier nichts zu erraten ist. Die Zahl schuetzt den Fall, dass jemand seine
 * Phrase doch von Hand "vereinfacht" hat.
 */
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

/**
 * Woran ein Chiffrat gebunden ist.
 *
 * Geht als "zusaetzliche Daten" in die Verschluesselung ein: sie werden nicht
 * mitverschluesselt, aber mitversiegelt. Wer ein Chiffrat auf einen anderen
 * Datensatz umhaengt, bekommt es nicht mehr auf - der Server koennte sonst
 * Datensaetze untereinander vertauschen, ohne den Inhalt zu kennen.
 */
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

/**
 * Einen Datensatz entschluesseln.
 *
 * Wirft, wenn das Chiffrat verfaelscht wurde ODER die Bindung nicht passt.
 * Beides ist derselbe Fehler: der Datensatz ist nicht der, der er zu sein
 * vorgibt.
 */
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

// ---------- Zeitraum-Kennung ----------

/**
 * Die verschleierte Kennung eines Monats.
 *
 * Der Server soll gezielt "diesen Zeitraum" ausliefern koennen, ohne zu wissen,
 * WELCHER Zeitraum das ist. Ein Klartext-Monat verriete, in welchen Zeitraeumen
 * jemand gearbeitet hat; gar keine Kennung zwaenge jedes Geraet, immer den
 * Gesamtbestand zu ziehen.
 *
 * Sichtbar bleibt nur, dass es N verschiedene Kennungen mit je einer bestimmten
 * Anzahl Datensaetze gibt.
 */
export async function bucketFor(key: CryptoKey, month: string): Promise<string> {
	const raw = await crypto.subtle.exportKey("raw", key);
	const mac = await crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, [
		"sign"
	]);
	const sig = await crypto.subtle.sign("HMAC", mac, enc.encode(`bucket|${month}`));
	// 16 Byte reichen: die Kennung muss eindeutig sein, nicht faelschungssicher -
	// wer sie faelscht, bekommt Chiffrate, die er nicht oeffnen kann.
	return toHex(new Uint8Array(sig).slice(0, 16));
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

/**
 * Eine neue Wiederherstellungs-Phrase: 24 Woerter, 256 Bit Entropie.
 *
 * BIP39, weil das Format eine Pruefsumme hat: ein vertipptes oder vertauschtes
 * Wort faellt beim Eingeben auf, statt still den falschen Schluessel zu erzeugen
 * und den Tresor als "kaputt" erscheinen zu lassen.
 */
export function createRecoveryPhrase(): string {
	return generateMnemonic(wordlist, KEY_BITS);
}

export function isValidRecoveryPhrase(phrase: string): boolean {
	return validateMnemonic(normalizePhrase(phrase), wordlist);
}

/**
 * Schreibweise vereinheitlichen, bevor irgendetwas damit gerechnet wird.
 *
 * Wer eine Phrase abtippt, bringt Grossbuchstaben, doppelte Leerzeichen und
 * Zeilenumbrueche mit. Ohne das schluege die Eingabe fehl, obwohl sie richtig
 * war.
 */
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

/**
 * Der bequeme Weg: der Passkey selbst liefert das Geheimnis.
 *
 * Die PRF-Erweiterung gibt zu einer festen Eingabe immer denselben Zufallswert
 * zurueck, aber nur diesem Passkey. Wer sich anmeldet, hat den Tresor damit in
 * derselben Bewegung offen - ohne Phrase, ohne zweites Geraet.
 *
 * Nicht jeder Authentifikator kann das (Windows Hello ueber TPM je nach Fassung
 * nicht). Wo es fehlt, bleibt die Phrase oder ein bereits entsperrtes Geraet -
 * siehe `wrapWithPhrase` und `wrapForDevice`.
 */
export async function kekFromPrf(prfOutput: ArrayBuffer, salt: Uint8Array): Promise<CryptoKey> {
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

export async function wrapWithPrf(vaultKey: CryptoKey, prfOutput: ArrayBuffer): Promise<KeyWrap> {
	const salt = crypto.getRandomValues(new Uint8Array(16));
	return wrapWith(await kekFromPrf(prfOutput, salt), vaultKey, salt, "passkey");
}

export async function unwrapWithPrf(wrap: KeyWrap, prfOutput: ArrayBuffer): Promise<CryptoKey> {
	return unwrapWith(await kekFromPrf(prfOutput, wrap.salt), wrap);
}

// ---------- Verpackung fuer ein neues Geraet ----------

/**
 * Der Hauptweg beim Koppeln: ein entsperrtes Geraet oeffnet ein neues.
 *
 * Das neue Geraet erzeugt ein fluechtiges Schluesselpaar und zeigt seinen
 * oeffentlichen Teil als Code. Das entsperrte Geraet verpackt den
 * Tresorschluessel dagegen und legt das Paket beim Server ab. Der Server sieht
 * dabei nur Chiffrat.
 *
 * P-256 statt X25519: in jeder Laufzeit vorhanden, waehrend X25519 in aelteren
 * Browsern fehlt. Fuer eine kurzlebige Kopplung ist der Unterschied ohne
 * Bedeutung.
 */
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
