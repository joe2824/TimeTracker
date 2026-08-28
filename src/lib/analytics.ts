// Anonyme Zaehlung (Aptabase). Bewusst das Minimum – drei Meldungen:
//
//   aktiv  – einmal je Kalendertag, zur ersten erreichten von vier festen
//            Uhrzeiten (siehe watchers). IMMER, sonst gaebe es keine Nutzerzahl.
//   fehler – jede ERROR-Zeile des Protokolls (log.ts)  \ nur mit dem
//   panic  – Absturz des Rust-Teils (lib.rs)           / Schalter
//
// Das Plugin haengt an JEDE Meldung und nicht abschaltbar an: appVersion, osName,
// osVersion, locale, engineName, engineVersion, isDebug, sdkVersion und eine je
// Prozess neu gewuerfelte sessionId.

/** Nur Strings und Zahlen – mehr nimmt Aptabase nicht an. */
export type TrackProps = Record<string, string | number>;

const COMMAND = "plugin:aptabase|track_event";

/** Laenge, ab der eine Meldung abgeschnitten wird. */
const MAX_LEN = 120;

/** Einmal fehlgeschlagen (kein Plugin, kein Tauri) = fuer diesen Lauf still. */
let broken = false;

/** Der Schalter aus den Einstellungen. `null` = noch nicht gelesen. */
let errorReports: boolean | null = null;

/** Vor dem Lesen des Schalters aufgelaufene Fehler - erst er entscheidet ueber sie. */
let buffered: { name: string; props?: TrackProps }[] = [];

/** Deckel gegen eine Fehlerschleife, die den Puffer volllaufen liesse. */
const MAX_BUFFER = 20;

/**
 * Laeuft das hier ueberhaupt in Tauri? Im Test (Node) und in `vite dev` im
 * Browser gibt es kein IPC, dann bleibt das Modul komplett stumm.
 */
function inTauri(): boolean {
	return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/**
 * Den Fehler-Schalter setzen und den Rust-Teil nachziehen (dort haengt der
 * Absturz-Hook, den das Frontend nicht erreicht).
 */
export function setErrorReportsEnabled(on: boolean): void {
	errorReports = on;
	const queue = buffered;
	buffered = [];
	if (on) for (const e of queue) void track(e.name, e.props);
	void tellRust(on);
}

/** Schalterstellung an den Rust-Teil melden. Fehler hier sind belanglos. */
async function tellRust(on: boolean): Promise<void> {
	if (!inTauri()) return;
	try {
		const { invoke } = await import("@tauri-apps/api/core");
		await invoke("set_error_reports_enabled", { on });
	} catch {
		// Aelterer Rust-Teil oder kein IPC – dann bleibt es beim Standard „aus".
	}
}

/**
 * Alles aus einer Meldung entfernen, was auf eine Person oder ihre Arbeit
 * zeigen koennte.
 */
export function redact(text: string): string {
	return text
		// Mailadressen zuerst - sonst frisst die Pfad-Regel den Teil hinter dem @.
		// Klammern und Satzzeichen gehoeren nie zur Adresse – ohne sie im
		// Ausschluss frisst die gierige Regel das "(" davor gleich mit.
		.replace(/[^\s<>"'(),;]+@[^\s<>"'(),;]+\.[a-z]{2,}/gi, "<mail>")
		// Windows-Pfade (C:\Users\..., \\server\freigabe\...)
		.replace(/(?:[a-z]:\\|\\\\)[^\s"'|]*/gi, "<pfad>")
		// POSIX-Pfade ab dem zweiten Segment (ein einzelnes "/" ist meist Text)
		.replace(/\/[\w.-]+\/[^\s"'|]*/g, "<pfad>")
		// Personalnummern, IDs, Zeitstempel
		.replace(/\d{4,}/g, "<zahl>")
		.slice(0, MAX_LEN);
}

/**
 * Woher die Meldung kommt.
 *
 * Steht an JEDEM Ereignis, damit sich Desktop und Web spaeter auseinanderhalten
 * lassen. Heute sendet nur der Desktop - der Browser hat keinen Weg zu Aptabase
 * (siehe `inTauri`), und ohne diese Angabe waere hinterher nicht zu sehen, ob
 * das an fehlenden Nutzern lag oder am fehlenden Weg.
 */
function herkunft(): "desktop" | "web" {
	return inTauri() ? "desktop" : "web";
}

/** Ein Ereignis melden – ohne Schalter. Wirft nie. */
export function track(name: string, props?: TrackProps): Promise<void> {
	if (broken || !inTauri()) return Promise.resolve();
	return (async () => {
		try {
			const { invoke } = await import("@tauri-apps/api/core");
			await invoke(COMMAND, { name, props: { ...props, art: herkunft() } });
		} catch {
			// Bewusst NICHT ins Protokoll: eine fehlgeschlagene Zaehlung ist kein
			// Vorfall – und da hier auch der Fehlerweg selbst laeuft, drehte sich
			// eine Fehlerzeile an dieser Stelle im Kreis.
			broken = true;
		}
	})();
}

/** Einen Fehler melden – nur wenn der Schalter es erlaubt. Wirft nie. */
export function trackError(name: string, props?: TrackProps): Promise<void> {
	if (errorReports === false) return Promise.resolve();
	if (errorReports === null) {
		if (buffered.length < MAX_BUFFER) buffered.push({ name, props });
		return Promise.resolve();
	}
	return track(name, props);
}
