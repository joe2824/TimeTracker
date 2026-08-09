// Anonyme Zaehlung (Aptabase). Bewusst das Minimum – und zwei getrennte Wege:
//
//   aktiv  – einmal je Kalendertag, ausgeloest um 12:00 Ortszeit (watchers).
//            IMMER. Ohne diese eine Meldung gaebe es keine Nutzerzahl, und
//            genau die ist der Grund fuer die ganze Anbindung.
//   fehler – jede ERROR-Zeile des Protokolls (siehe log.ts)  \ nur mit dem
//   panic  – Absturz des Rust-Teils (siehe lib.rs)           / Schalter
//
// Warum kein Ereignis beim Start und beim Beenden, obwohl das der uebliche Weg
// waere, aktive Nutzer zu zaehlen: der Zeitstempel eines solchen Ereignisses
// IST der Arbeitsbeginn bzw. das Arbeitsende. In einer Zeiterfassung, die
// Kollegen benutzen, waere das die eine Zahl, die hier niemanden etwas angeht –
// und sie liesse sich aus dem Aptabase-Diagramm direkt ablesen.
//
// Die Tagesmeldung um 12:00 loest das: sie zaehlt denselben Nutzer genauso
// einmal pro Tag, aber alle Meldungen aller Leute liegen auf derselben Uhrzeit.
// Preis dafuer ist eine Untererfassung – wer mittags nicht offen hat, faellt
// aus der Zaehlung. Das ist die richtige Richtung fuer den Fehler.
//
// Keine Ereignisse fuer Timer, Berichte, Importe oder Ansichten. Es geht darum
// zu sehen, ob und womit die App scheitert – nicht darum, Arbeit zu vermessen.
//
// ---- Was tatsaechlich das Geraet verlaesst ----
//
// Von uns: der Ereignisname, und bei Fehlern der Meldungstext, durch redact()
// von Pfaden, Mailadressen und langen Ziffernfolgen befreit. Nie das `detail`
// einer Protokollzeile (Stack, Ursprungsfehler, Dateiname).
//
// Vom Plugin automatisch und NICHT abschaltbar (es baut den Rumpf selbst,
// siehe client.rs `track_event`): appVersion, osName, osVersion, locale,
// engineName, engineVersion, isDebug, sdkVersion sowie eine sessionId, die je
// Prozess neu gewuerfelt wird. Das haengt damit auch an der Tagesmeldung.
// Weniger geht mit diesem Plugin nicht, ohne es zu ersetzen.
//
// Kein @aptabase/tauri: das Paket auf npm (0.4.1) haengt noch an
// @tauri-apps/api v1 und zoege eine zweite, inkompatible IPC-Fassung herein.
// Die v2-taugliche Fassung liegt nur unveroeffentlicht auf GitHub – und ist
// genau der eine invoke()-Aufruf weiter unten.

/** Nur Strings und Zahlen – mehr nimmt Aptabase nicht an. */
export type TrackProps = Record<string, string | number>;

const COMMAND = "plugin:aptabase|track_event";

/** Laenge, ab der eine Meldung abgeschnitten wird. */
const MAX_LEN = 120;

/** Einmal fehlgeschlagen (kein Plugin, kein Tauri) = fuer diesen Lauf still. */
let broken = false;

/**
 * Der Schalter aus den Einstellungen. `null` = noch nicht gelesen.
 *
 * Gilt nur fuer Fehler und Abstuerze. Der Start liest die Einstellungen erst
 * als zweiten Schritt, und ausgerechnet davor passieren die interessantesten
 * Fehler (Datenordner nicht schreibbar, settings.json kaputt). Deshalb wird bis
 * dahin gepuffert statt gesendet oder verworfen – erst der Schalter entscheidet,
 * was mit dem Puffer geschieht.
 */
let errorReports: boolean | null = null;

/** Vor dem Lesen des Schalters aufgelaufene Fehler. */
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
 *
 * Beim ersten Aufruf entscheidet sich, was mit dem Startpuffer passiert:
 * senden oder verwerfen.
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
 *
 * Die meisten Fehlermeldungen sind feste Texte aus diesem Projekt, ein paar
 * setzen aber Fremdes ein – `Unhandled: ${e.message}` etwa, oder der Pfad aus
 * write_export_file. Genau die faengt das hier ab, statt sich darauf zu
 * verlassen, dass an jeder einzelnen Aufrufstelle daran gedacht wurde.
 *
 * Reihenfolge zaehlt: Mailadressen zuerst, sonst frisst die Pfad-Regel den Teil
 * hinter dem Klammeraffen.
 */
export function redact(text: string): string {
	return text
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
 * Ein Ereignis melden – ohne Schalter. Wirft nie.
 *
 * Nur fuer die Tagesmeldung gedacht. Alles, was ein Fehler ist, gehoert nach
 * trackError().
 *
 * Der Rust-Teil legt das Ereignis nur in eine Warteschlange; gesendet wird
 * gebuendelt im Hintergrund. Abwarten muss der Aufrufer das nicht.
 */
export function track(name: string, props?: TrackProps): Promise<void> {
	if (broken || !inTauri()) return Promise.resolve();
	return (async () => {
		try {
			const { invoke } = await import("@tauri-apps/api/core");
			await invoke(COMMAND, { name, props });
		} catch {
			// Bewusst NICHT ins Protokoll: eine fehlgeschlagene Zaehlung ist kein
			// Vorfall – und da hier auch der Fehlerweg selbst laeuft, drehte sich
			// eine Fehlerzeile an dieser Stelle im Kreis.
			broken = true;
		}
	})();
}

/**
 * Einen Fehler melden – nur wenn der Schalter es erlaubt. Wirft nie.
 *
 * Vor dem Lesen der Einstellungen wird gepuffert, siehe `errorReports`.
 */
export function trackError(name: string, props?: TrackProps): Promise<void> {
	if (errorReports === false) return Promise.resolve();
	if (errorReports === null) {
		if (buffered.length < MAX_BUFFER) buffered.push({ name, props });
		return Promise.resolve();
	}
	return track(name, props);
}
