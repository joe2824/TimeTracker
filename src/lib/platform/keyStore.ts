// Der Tresorschluessel, so lange abgelegt, dass eine neue Sitzung ihn nicht
// mehr abfragen muss - aber ohne dass jemand die rohen Bytes je wieder
// herausbekommt.
//
// `crypto.subtle.importKey(..., extractable: false, ...)` ist eine Zusage der
// Web-Crypto-Spezifikation, keine betriebssystemabhaengige Vermutung: ein
// solcher Schluessel gibt `exportKey` nie wieder Bytes zurueck, auch nicht an
// den eigenen Code. IndexedDB kann `CryptoKey`-Objekte direkt speichern
// (structured clone) - eine eigene, kleine Datenbank dafuer, getrennt von der
// Datei-Ablage in `fs.ts`, die nur Text kennt.
//
// Fuer die laufende Sitzung bleibt der Schluessel im Speicher exportierbar
// (siehe `account.svelte.ts`) - nur die hier abgelegte Kopie ist es nicht.
//
// Abgelegt wird das ganze `VaultKey`-Paar (AES und HMAC): der HMAC-Teil rechnet
// die Monats- und Nachweiskennungen, und ohne ihn muesste dafuer exportiert
// werden - was fuer diese Kopie mit Absicht fuer immer fehlschlaegt.

import { openIndexedDbStore } from "./indexedDb";
import type { VaultKey } from "../crypto/vault";

const KEY_ID = "vault";

const { tx } = openIndexedDbStore("timetracker-keys", "keys");

/** Den Schluessel ablegen - nicht-exportierbar, sonst unveraendert brauchbar. */
export async function saveLocalVaultKey(key: VaultKey): Promise<void> {
	await tx("readwrite", (s) => s.put(key, KEY_ID));
}

/** Der abgelegte Schluessel, oder `null`, wenn keiner liegt. */
export async function loadLocalVaultKey(): Promise<VaultKey | null> {
	const key = await tx<VaultKey | undefined>("readonly", (s) => s.get(KEY_ID));
	return key ?? null;
}

export async function clearLocalVaultKey(): Promise<void> {
	await tx("readwrite", (s) => s.delete(KEY_ID));
}
