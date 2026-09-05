// Der Vault-Schluessel, so lange abgelegt, dass eine neue Sitzung ihn nicht
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

// ---------- Die Ablage von vor der Umbenennung ----------
//
// Sie hiess `timetracker-schluessel`/`schluessel` und trug einen EINZELNEN
// nicht-exportierbaren AES-Schluessel. Hier liegt seit `ada4ba1` das Paar aus
// AES- und HMAC-Teil, und der HMAC-Teil laesst sich aus dem alten Wert nicht
// mehr herstellen: dafuer braeuchte es dessen Bytes, und genau die gibt ein
// nicht-exportierbarer Schluessel nie wieder her. Eine Uebernahme ist damit
// ausgeschlossen - was bleibt, ist die Auskunft, warum der Start nicht
// durchkommt, und das Wegraeumen, sobald wieder ein brauchbarer Schluessel da
// ist.

const LEGACY_DB = "timetracker-schluessel";

/** Ob die alte Ablage noch im Profil liegt. */
export async function hasLegacyVaultKey(): Promise<boolean> {
	if (typeof indexedDB.databases !== "function") return false;
	const dbs = await indexedDB.databases().catch(() => []);
	return dbs.some((db) => db.name === LEGACY_DB);
}

/** Die alte Ablage wegraeumen. Sie liegt sonst fuer immer im Profil. */
export async function discardLegacyVaultKey(): Promise<void> {
	await new Promise<void>((resolve) => {
		const req = indexedDB.deleteDatabase(LEGACY_DB);
		// Auch bei "blockiert" (eine andere Lasche haelt sie offen) weitergehen:
		// der naechste Start versucht es erneut, und niemand wartet darauf.
		req.onsuccess = req.onerror = req.onblocked = () => resolve();
	});
}
