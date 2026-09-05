// Die Schluessel-Ablage von vor der Umbenennung nachstellen:
// `timetracker-schluessel`/`schluessel`/`tresor`, Wert ein einzelner CryptoKey.
// Nur fuer Tests - der Betrieb kann damit nichts mehr anfangen (siehe
// platform/keyStore.ts).

/** Die alte Datenbank anlegen und einen Wert hineinschreiben. */
export function writeLegacyVaultKey(value: unknown = "alter-schluessel"): Promise<void> {
	return new Promise((resolve, reject) => {
		const req = indexedDB.open("timetracker-schluessel", 1);
		req.onupgradeneeded = () => req.result.createObjectStore("schluessel");
		req.onerror = () => reject(req.error);
		req.onsuccess = () => {
			const db = req.result;
			const t = db.transaction("schluessel", "readwrite");
			t.objectStore("schluessel").put(value, "tresor");
			t.oncomplete = () => {
				db.close();
				resolve();
			};
			t.onerror = () => reject(t.error);
		};
	});
}
