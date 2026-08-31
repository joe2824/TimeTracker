// Wo die Daten liegen.
//
// store.ts unterscheidet "Datei fehlt" von "Datei ist kaputt" - die Ablage muss den
// Unterschied durchreichen, sonst gehen Daten still verloren.

import {
	BaseDirectory,
	exists as fsExists,
	mkdir as fsMkdir,
	readDir as fsReadDir,
	readTextFile as fsReadTextFile,
	remove as fsRemove,
	rename as fsRename,
	stat as fsStat,
	writeTextFile as fsWriteTextFile
} from "@tauri-apps/plugin-fs";

export { BaseDirectory };

export interface DirEntry {
	name: string;
}

export interface FileInfo {
	size: number;
}

/** Was store.ts braucht - nicht mehr. */
export interface StorageBackend {
	exists(path: string): Promise<boolean>;
	mkdir(path: string): Promise<void>;
	readDir(path: string): Promise<DirEntry[]>;
	readTextFile(path: string): Promise<string>;
	writeTextFile(path: string, contents: string): Promise<void>;
	/** Anhaengen statt ersetzen - fuer das Protokoll. */
	appendTextFile(path: string, contents: string): Promise<void>;
	remove(path: string): Promise<void>;
	rename(from: string, to: string): Promise<void>;
	stat(path: string): Promise<FileInfo>;
}

// ---------- Rechner: das Dateisystem ----------

const opts = { baseDir: BaseDirectory.AppData } as const;

const tauriBackend: StorageBackend = {
	exists: (p) => fsExists(p, opts),
	mkdir: (p) => fsMkdir(p, { baseDir: BaseDirectory.AppData, recursive: true }),
	readDir: async (p) => (await fsReadDir(p, opts)).map((e) => ({ name: e.name })),
	readTextFile: (p) => fsReadTextFile(p, opts),
	writeTextFile: (p, c) => fsWriteTextFile(p, c, opts),
	appendTextFile: (p, c) => fsWriteTextFile(p, c, { append: true, ...opts }),
	remove: (p) => fsRemove(p, opts),
	rename: (from, to) =>
		fsRename(from, to, {
			oldPathBaseDir: BaseDirectory.AppData,
			newPathBaseDir: BaseDirectory.AppData
		}),
	stat: async (p) => ({ size: (await fsStat(p, opts)).size })
};

// ---------- Browser: IndexedDB ----------

const DB_NAME = "timetracker";
const STORE = "dateien";

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

/** Ein Fehler, der sich anfuehlt wie ein fehlendes Dateisystem-Objekt. */
class NotFound extends Error {
	constructor(path: string) {
		super(`Datei nicht gefunden: ${path}`);
		this.name = "NotFound";
	}
}

const browserBackend: StorageBackend = {
	async exists(path) {
		// `count` statt `get`: der Wert kann gross sein, und gebraucht wird nur die
		// Antwort ja/nein.
		if ((await tx<number>("readonly", (s) => s.count(path))) > 0) return true;
		// Es gibt keine Ordner, der Pfad ist Teil des Schluessels - "logs" allein
		// steht also nie da. Wer nach einem Ordner fragt, meint trotzdem "liegt da
		// etwas drin?", und genau das beantwortet die Praefixsuche. Ohne sie sieht
		// jeder Aufrufer, der erst auf den Ordner prueft, einen leeren Bestand.
		const prefix = path.endsWith("/") ? path : `${path}/`;
		const keys = await tx<IDBValidKey[]>("readonly", (s) => s.getAllKeys());
		return keys.some((k) => String(k).startsWith(prefix));
	},

	// Es gibt keine Ordner - der Pfad ist Teil des Schluessels. Nichts zu tun.
	async mkdir() {},

	async readDir(path) {
		const prefix = path.endsWith("/") ? path : `${path}/`;
		const keys = await tx<IDBValidKey[]>("readonly", (s) => s.getAllKeys());
		return keys
			.map(String)
			.filter((k) => k.startsWith(prefix))
			.map((k) => ({ name: k.slice(prefix.length) }))
			// Nur die eigene Ebene, keine Unterordner - genau wie readDir es tut.
			.filter((e) => !e.name.includes("/"));
	},

	async readTextFile(path) {
		const v = await tx<string | undefined>("readonly", (s) => s.get(path));
		if (v === undefined) throw new NotFound(path);
		return v;
	},

	async writeTextFile(path, contents) {
		await tx("readwrite", (s) => s.put(contents, path));
	},

	async appendTextFile(path, contents) {
		const old = (await tx<string | undefined>("readonly", (s) => s.get(path))) ?? "";
		await tx("readwrite", (s) => s.put(old + contents, path));
	},

	async remove(path) {
		await tx("readwrite", (s) => s.delete(path));
	},

	async rename(from, to) {
		const v = await tx<string | undefined>("readonly", (s) => s.get(from));
		if (v === undefined) throw new NotFound(from);
		await tx("readwrite", (s) => s.put(v, to));
		await tx("readwrite", (s) => s.delete(from));
	},

	async stat(path) {
		const v = await tx<string | undefined>("readonly", (s) => s.get(path));
		if (v === undefined) throw new NotFound(path);
		// Laenge in Bytes, nicht in Zeichen: store.ts entscheidet daran, ob eine
		// Datei klein genug ist, um leer zu sein.
		return { size: new TextEncoder().encode(v).length };
	}
};

// ---------- Der eingestellte Weg ----------

let backend: StorageBackend = tauriBackend;

/** Im Browser: den Bestand in IndexedDB fuehren. Einmal beim Start rufen. */
export function useBrowserStorage(): void {
	backend = browserBackend;
}

export const storage: StorageBackend = {
	exists: (p) => backend.exists(p),
	mkdir: (p) => backend.mkdir(p),
	readDir: (p) => backend.readDir(p),
	readTextFile: (p) => backend.readTextFile(p),
	writeTextFile: (p, c) => backend.writeTextFile(p, c),
	appendTextFile: (p, c) => backend.appendTextFile(p, c),
	remove: (p) => backend.remove(p),
	rename: (a, b) => backend.rename(a, b),
	stat: (p) => backend.stat(p)
};
