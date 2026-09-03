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

const DB_NAME = "timetracker-schluessel";
const STORE = "schluessel";
const KEY_ID = "tresor";

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
	dbPromise ??= new Promise((resolve, reject) => {
		const req = indexedDB.open(DB_NAME, 1);
		req.onupgradeneeded = () => {
			if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
		};
		req.onsuccess = () => resolve(req.result);
		req.onerror = () => reject(req.error);
	});
	return dbPromise;
}

function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
	return openDb().then(
		(db) =>
			new Promise<T>((resolve, reject) => {
				const t = db.transaction(STORE, mode);
				const req = fn(t.objectStore(STORE));
				req.onsuccess = () => resolve(req.result);
				req.onerror = () => reject(req.error);
			})
	);
}

/** Den Schluessel ablegen - nicht-exportierbar, sonst unveraendert brauchbar. */
export async function saveLocalVaultKey(key: CryptoKey): Promise<void> {
	await tx("readwrite", (s) => s.put(key, KEY_ID));
}

/** Der abgelegte Schluessel, oder `null`, wenn keiner liegt. */
export async function loadLocalVaultKey(): Promise<CryptoKey | null> {
	const key = await tx<CryptoKey | undefined>("readonly", (s) => s.get(KEY_ID));
	return key ?? null;
}

export async function clearLocalVaultKey(): Promise<void> {
	await tx("readwrite", (s) => s.delete(KEY_ID));
}
