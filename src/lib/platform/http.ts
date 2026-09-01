// Der Weg ins Netz - je nachdem, wo wir laufen.
import { isTauri } from "./env";
import type { FetchFn } from "../sync/api";

/** Einmal geladen, dann behalten - der dynamische Import kostet sonst je Aufruf. */
let tauriFetch: FetchFn | null = null;

/**
 * Die Abrufmethode dieser Umgebung.
 *
 * In der Desktop-Anwendung NICHT `globalThis.fetch`: deren Fenster hat die Herkunft
 * `tauri://localhost`, jeder Serveraufruf waere damit CORS-pflichtig.
 */
export const platformFetch: FetchFn = async (input, init) => {
	if (!isTauri()) return globalThis.fetch(input, init);
	if (!tauriFetch) {
		const module = await import("@tauri-apps/plugin-http");
		tauriFetch = module.fetch as FetchFn;
	}
	return tauriFetch(input, init);
};
