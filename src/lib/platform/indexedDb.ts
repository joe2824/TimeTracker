// Gemeinsame IndexedDB-Verdrahtung fuer die Browser-Ablagen dieser App -
// platform/fs.ts (Dateien) und platform/keyStore.ts (Tresorschluessel) rufen
// dies je einmal fuer ihre eigene Datenbank auf, statt beide dieselbe
// Oeffnen/Transaktion-Logik von Hand nachzubauen.

export interface IndexedDbStore {
	/** Ein Objektspeicher, eine Transaktion je Aufruf. */
	tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T>;
}

/** Eine IndexedDB mit genau einem Objektspeicher oeffnen - einmal je Aufrufer gecacht. */
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
			req.onerror = () => reject(req.error);
			// Eine andere offene Verbindung (z.B. ein zweiter Tab) blockiert das
			// Anheben der Version - ohne das haengt der Aufrufer fuer immer, statt
			// eine Fehlermeldung zu bekommen. dbPromise wird zurueckgesetzt: loest
			// sich die Blockade spaeter (die andere Verbindung schliesst), darf der
			// naechste Versuch es erneut probieren, statt fuer immer an diesem
			// einen Fehlschlag haengenzubleiben.
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
