// Wo laufen wir gerade.

/** Laeuft das Programm in der Desktop-Huelle? */
export function isTauri(): boolean {
	return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/** Was diese Umgebung kann. */
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
