// In-Memory-Dateisystem als Ersatz fuer tauri-plugin-fs. Nur fuer Tests.
//
// Liegt geteilt hier, weil store.test.ts und app.svelte.test.ts denselben Mock
// brauchen: der eine prueft die Dateien, der andere den Zustand darueber.

/** Schluessel = Pfad relativ zum AppData-Ordner, Wert = Dateiinhalt. */
export const files = new Map<string, string>();

/**
 * Erzwingbare Fehler.
 *
 * `renameThrows` deckt den Fallback-Zweig von writeJson ab – den, der bei
 * Stromausfall eine halbe Datei hinterlassen kann. Ohne ihn lief genau der
 * Zweig in keinem Test.
 */
export const fsFaults = { renameThrows: false };

export function resetFakeFs(): void {
	files.clear();
	fsFaults.renameThrows = false;
}

export const fakeFs = {
	BaseDirectory: { AppData: 1 },
	exists: async (p: string) => files.has(p) || p === "data",
	mkdir: async () => {},
	readDir: async () => [...files.keys()].map((p) => ({ name: p.split("/").pop() })),
	readTextFile: async (p: string) => {
		const txt = files.get(p);
		if (txt === undefined) throw new Error(`ENOENT: ${p}`);
		return txt;
	},
	remove: async (p: string) => {
		files.delete(p);
	},
	rename: async (from: string, to: string) => {
		if (fsFaults.renameThrows) throw new Error("rename nicht moeglich");
		files.set(to, files.get(from)!);
		files.delete(from);
	},
	writeTextFile: async (p: string, txt: string) => {
		files.set(p, txt);
	}
};
