// Gemeinsame IndexedDB-Verdrahtung für die Browser-Ablagen dieser App -
// platform/fs.ts (Dateien) und platform/keyStore.ts (Vault-Schlüssel) rufen
// dies je einmal für ihre eigene Datenbank auf, statt beide dieselbe
// Öffnen/Transaktion-Logik von Hand nachzubauen.

export interface IndexedDbStore {
	/** Ein Objektspeicher, eine Transaktion je Aufruf. */
	tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T>;
}

/** Eine IndexedDB mit genau einem Objektspeicher öffnen - einmal je Aufrufer gecacht. */
export function openIndexedDbStore(dbName: string, storeName: string): IndexedDbStore {
	let dbPromise: Promise<IDBDatabase> | null = null;

	function openDb(): Promise<IDBDatabase> {
		dbPromise ??= new Promise((resolve, reject) => {
			const req = indexedDB.open(dbName, 1);
			req.onupgradeneeded = () => {
				if (!req.result.objectStoreNames.contains(storeName)) {
					req.result.createObjectStore(storeName);
				}
			};
			req.onsuccess = () => resolve(req.result);
			// dbPromise wird bei jedem Fehlschlag zurückgesetzt - sonst bleibt ein
			// einmaliger, voruebergehender Fehler (z.B. Kontingent, blockierte
			// Verbindung) fuer den Rest der Sitzung an dieser einen Ablehnung
			// haengen, und jeder spaetere Aufruf scheitert sofort ohne neuen
			// Versuch.
			req.onerror = () => {
				dbPromise = null;
				reject(req.error);
			};
			req.onblocked = () => {
				dbPromise = null;
				reject(new Error(`${dbName}: eine andere Verbindung blockiert das Öffnen`));
			};
		});
		return dbPromise;
	}

	function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
		return openDb().then(
			(db) =>
				new Promise<T>((resolve, reject) => {
					const t = db.transaction(storeName, mode);
					const req = fn(t.objectStore(storeName));
					req.onsuccess = () => resolve(req.result);
					req.onerror = () => reject(req.error);
				})
		);
	}

	return { tx };
}
