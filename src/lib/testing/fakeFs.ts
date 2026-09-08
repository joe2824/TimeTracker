// In-Memory-Dateisystem als Ersatz für tauri-plugin-fs. Nur für Tests.
//
// Liegt geteilt hier, weil store.test.ts und app.svelte.test.ts denselben Mock
// brauchen: der eine prüft die Dateien, der andere den Zustand darüber.

/** Schlüssel = Pfad relativ zum AppData-Ordner, Wert = Dateiinhalt. */
export const files = new Map<string, string>();

/** Erzwingbare Fehler. */
export const fsFaults = { renameThrows: false, existsThrows: false };

/** Angelegte Ordner. "data" gibt es immer, den legt niemand extra an. */
const dirs = new Set<string>(["data"]);

/**
 * Jeder Schreibvorgang in der Reihenfolge, in der er kam – auch die von
 * Zwischendateien, die gleich wieder verschwinden.
 */
export const written: string[] = [];

/**
 * Anhalten des nächsten Schreibvorgangs, bis der Test ihn freigibt.
 *
 * Ohne diese Sperre lässt sich eine Reihenfolge nicht prüfen: der Fake
 * schreibt sofort, „während noch geschrieben wird" wäre im Test also nur eine
 * Vermutung über Microtask-Reihenfolgen – und die trifft mal zu und mal nicht.
 * Damit hängt gerade die Warteschlange in store.ts an einem Zufall.
 */
let writeGate: Promise<void> | null = null;
let openGate: (() => void) | null = null;

/**
 * Alle Schreibvorgänge anhalten. Liefert die Freigabe.
 *
 * Nach dem Aufruf hängt jedes writeTextFile, bis die Freigabe kommt – so lässt
 * sich ein Vorgang nachweislich „noch offen" halten, während ein zweiter startet.
 */
export function blockWrites(): () => void {
	writeGate = new Promise<void>((resolve) => (openGate = resolve));
	return releaseWrites;
}

function releaseWrites(): void {
	openGate?.();
	writeGate = null;
	openGate = null;
}

export function resetFakeFs(): void {
	// Zuerst: eine im Test vergessene Sperre liesse sonst jeden folgenden
	// Schreibvorgang hängen, und die Suite bliebe ohne Fehlermeldung stehen.
	releaseWrites();
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
		// liegt – sonst hält ein Aufrufer seinen frisch erzeugten Ordner für leer
		// und lässt das Verzeichnis gar nicht erst lesen.
		return files.has(p) || dirs.has(p) || [...files.keys()].some((f) => f.startsWith(`${p}/`));
	},
	mkdir: async (p: string) => {
		dirs.add(p);
	},
	// Nur den gefragten Ordner: sonst sähe jeder Leser auch die Dateien der
	// anderen (Einträge, Einstellungen, Protokolle) und die Tests hätten sich
	// still auf ein Dateisystem verlassen, das es so nicht gibt.
	readDir: async (dir: string) =>
		[...files.keys()]
			.filter((p) => p.startsWith(`${dir}/`))
			.map((p) => ({ name: p.slice(dir.length + 1) })),
	// Nur die Grösse: mehr fragt niemand ab (pruneEmptyMonthFiles sieht damit,
	// ob eine Datei überhaupt leer sein kann, ohne sie zu lesen).
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
		// Fehlt die Quelle, scheitert das echte rename – und der Aufrufer fällt in
		// seinen Ersatzweg. Ein Fake, der hier still `undefined` ablegt, verdeckte
		// genau das: zwei gleichzeitige Speicherungen derselben Datei nahmen sich
		// ihre Zwischendatei gegenseitig weg, ohne dass ein Test es sah.
		const txt = files.get(from);
		if (txt === undefined) throw new Error(`ENOENT: ${from}`);
		files.set(to, txt);
		files.delete(from);
	},
	// `append` mitspielen: das Protokoll hängt jede Zeile an, ein überschreibender
	// Fake hätte genau den Fehler durchgewunken, den es zu vermeiden gilt.
	writeTextFile: async (p: string, txt: string, opts?: { append?: boolean }) => {
		if (writeGate) await writeGate;
		written.push(p);
		files.set(p, opts?.append ? (files.get(p) ?? "") + txt : txt);
	}
};
