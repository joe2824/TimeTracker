// Der Vault-Schlüssel, so lange abgelegt, dass eine neue Sitzung ihn nicht
// mehr abfragen muss - aber ohne dass jemand die rohen Bytes je wieder
// herausbekommt.
//
// `crypto.subtle.importKey(..., extractable: false, ...)` ist eine Zusage der
// Web-Crypto-Spezifikation, keine betriebssystemabhängige Vermutung: ein
// solcher Schlüssel gibt `exportKey` nie wieder Bytes zurück, auch nicht an
// den eigenen Code. IndexedDB kann `CryptoKey`-Objekte direkt speichern
// (structured clone) - eine eigene, kleine Datenbank dafür, getrennt von der
// Datei-Ablage in `fs.ts`, die nur Text kennt.
//
// Für die laufende Sitzung bleibt der Schlüssel im Speicher exportierbar
// (siehe `account.svelte.ts`) - nur die hier abgelegte Kopie ist es nicht.
//
// Abgelegt wird das ganze `VaultKey`-Paar (AES und HMAC): der HMAC-Teil rechnet
// die Monats- und Nachweiskennungen, und ohne ihn müsste dafür exportiert
// werden - was für diese Kopie mit Absicht für immer fehlschlägt.

import { openIndexedDbStore } from "./indexedDb";
import type { VaultKey } from "../crypto/vault";

const KEY_ID = "vault";

const { tx } = openIndexedDbStore("timetracker-keys", "keys");

/** Den Schlüssel ablegen - nicht-exportierbar, sonst unverändert brauchbar. */
export async function saveLocalVaultKey(key: VaultKey): Promise<void> {
	await tx("readwrite", (s) => s.put(key, KEY_ID));
}

/** Der abgelegte Schlüssel, oder `null`, wenn keiner liegt. */
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
// nicht-exportierbaren AES-Schlüssel. Hier liegt seit `ada4ba1` das Paar aus
// AES- und HMAC-Teil, und der HMAC-Teil lässt sich aus dem alten Wert nicht
// mehr herstellen: dafür bräuchte es dessen Bytes, und genau die gibt ein
// nicht-exportierbarer Schlüssel nie wieder her. Eine Übernahme ist damit
// ausgeschlossen - was bleibt, ist die Auskunft, warum der Start nicht
// durchkommt, und das Wegräumen, sobald wieder ein brauchbarer Schlüssel da
// ist.

const LEGACY_DB = "timetracker-schluessel";

/** Ob die alte Ablage noch im Profil liegt. */
export async function hasLegacyVaultKey(): Promise<boolean> {
	if (typeof indexedDB.databases !== "function") return false;
	const dbs = await indexedDB.databases().catch(() => []);
	return dbs.some((db) => db.name === LEGACY_DB);
}

/** Die alte Ablage wegräumen. Sie liegt sonst für immer im Profil. */
export async function discardLegacyVaultKey(): Promise<void> {
	await new Promise<void>((resolve) => {
		const req = indexedDB.deleteDatabase(LEGACY_DB);
		// Auch bei "blockiert" (eine andere Lasche hält sie offen) weitergehen:
		// der nächste Start versucht es erneut, und niemand wartet darauf.
		req.onsuccess = req.onerror = req.onblocked = () => resolve();
	});
}
