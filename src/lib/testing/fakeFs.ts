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
 *
 * `existsThrows` steht fuer ein Dateisystem, das gar nicht antwortet – so
 * verhaelt sich das fs-Plugin, wenn ihm die Berechtigung fehlt. Der Start muss
 * das melden, statt im Ladebildschirm haengen zu bleiben.
 */
export const fsFaults = { renameThrows: false, existsThrows: false };

/** Angelegte Ordner. "data" gibt es immer, den legt niemand extra an. */
const dirs = new Set<string>(["data"]);

/**
 * Jeder Schreibvorgang in der Reihenfolge, in der er kam – auch die von
 * Zwischendateien, die gleich wieder verschwinden.
 *
 * Ohne das war der Weg zum Ziel unsichtbar: eine temp-Datei, die kein echtes
 * Dateisystem angenommen haette, fiel in keinem Test auf, weil am Ende nur die
 * fertige Datei dastand.
 */
export const written: string[] = [];

export function resetFakeFs(): void {
	files.clear();
	dirs.clear();
	dirs.add("data");
	written.length = 0;
	fsFaults.renameThrows = false;
	fsFaults.existsThrows = false;
}

export const fakeFs = {
	BaseDirectory: { AppData: 1 },
	exists: async (p: string) => {
		if (fsFaults.existsThrows) throw new Error("fs.scope forbidden path");
		// Ordner gelten als vorhanden, sobald sie angelegt wurden oder etwas darin
		// liegt – sonst haelt ein Aufrufer seinen frisch erzeugten Ordner fuer leer
		// und laesst das Verzeichnis gar nicht erst lesen.
		return files.has(p) || dirs.has(p) || [...files.keys()].some((f) => f.startsWith(`${p}/`));
	},
	mkdir: async (p: string) => {
		dirs.add(p);
	},
	// Nur den gefragten Ordner: sonst saehe jeder Leser auch die Dateien der
	// anderen (Eintraege, Einstellungen, Protokolle) und die Tests haetten sich
	// still auf ein Dateisystem verlassen, das es so nicht gibt.
	readDir: async (dir: string) =>
		[...files.keys()]
			.filter((p) => p.startsWith(`${dir}/`))
			.map((p) => ({ name: p.slice(dir.length + 1) })),
	// Nur die Groesse: mehr fragt niemand ab (pruneEmptyMonthFiles sieht damit,
	// ob eine Datei ueberhaupt leer sein kann, ohne sie zu lesen).
	stat: async (p: string) => {
		const txt = files.get(p);
		if (txt === undefined) throw new Error(`ENOENT: ${p}`);
		return { size: txt.length };
	},
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
	// `append` mitspielen: das Protokoll haengt jede Zeile an, ein ueberschreibender
	// Fake haette genau den Fehler durchgewunken, den es zu vermeiden gilt.
	writeTextFile: async (p: string, txt: string, opts?: { append?: boolean }) => {
		written.push(p);
		files.set(p, opts?.append ? (files.get(p) ?? "") + txt : txt);
	}
};
