// Wo laufen wir gerade.
//
// Bewusst EINE Antwort an EINER Stelle. Verstreute Pruefungen auf
// `window.__TAURI__` sind der Weg, auf dem sich zwei Fassungen einer Abfrage
// einschleichen, die sich irgendwann widersprechen.
//
// Die Aufteilung in zwei Bauwege kommt spaeter (eine Oberflaeche, zwei Ziele).
// Bis dahin genuegt diese Abfrage zur Laufzeit - und sie bleibt auch danach
// richtig.

/**
 * Laeuft das Programm in der Desktop-Huelle?
 *
 * Gemessen an dem, was Tauri in das Fenster stellt. Der Browser hat das nicht,
 * und niemand kann es dort versehentlich haben.
 */
export function isTauri(): boolean {
	return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/**
 * Was diese Umgebung kann.
 *
 * Wird gebraucht, um Bereiche AUSZUBLENDEN, die es im Browser nicht geben kann -
 * statt sie dort nachzubauen. Ein Kalender-Import ohne Outlook waere eine
 * Schaltflaeche, die nur enttaeuschen kann.
 */
export const capabilities = {
	get outlook(): boolean {
		return isTauri();
	},
	get globalShortcuts(): boolean {
		return isTauri();
	},
	get idleDetection(): boolean {
		return isTauri();
	},
	get updater(): boolean {
		return isTauri();
	},
	get tray(): boolean {
		return isTauri();
	},
	get autostart(): boolean {
		return isTauri();
	},
	/** Ob Geheimnisse vom Betriebssystem geschuetzt werden koennen. */
	get protectedSecrets(): boolean {
		return isTauri();
	}
};
