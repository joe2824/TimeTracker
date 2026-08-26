// Der Weg ins Netz - je nachdem, wo wir laufen.
//
// Im Browser das eingebaute `fetch`. Die PWA wird vom selben Server
// ausgeliefert, mit dem sie spricht; das ist dieselbe Herkunft, und alles
// funktioniert von selbst.
//
// In der Desktop-Anwendung NICHT. Deren Fenster hat die Herkunft
// `tauri://localhost` (unter Windows `http://tauri.localhost`), und ein Aufruf
// an `https://tracker.example.de` ist damit ein Zugriff ueber Herkunftsgrenzen
// hinweg. Der Browserkern im Fenster schickt dann erst eine Vorabfrage und
// erwartet Freigabe-Kopfzeilen - die kein Server sinnvoll ausstellen kann, denn
// `tauri://localhost` ist auf jedem Rechner dieselbe Zeichenkette. Wer sie
// erlaubte, erlaubte jede Tauri-Anwendung der Welt.
//
// Deshalb geht die Desktop-Anwendung durch den Rust-Teil. Der ist kein Browser,
// kennt keine Herkunft und fragt niemanden um Erlaubnis; was er darf, steht in
// src-tauri/capabilities/default.json.
import { isTauri } from "./env";
import type { FetchFn } from "../sync/api";

/** Einmal geladen, dann behalten - der dynamische Import kostet sonst je Aufruf. */
let tauriFetch: FetchFn | null = null;

/**
 * Die Abrufmethode dieser Umgebung.
 *
 * Bewusst eine Funktion, die beim ERSTEN Aufruf entscheidet, und nicht ein Wert,
 * der beim Laden des Moduls feststeht: das Plugin wird dynamisch geladen, und
 * ein Modul, das beim Import schon etwas nachlaedt, macht jeden Start langsamer -
 * auch den ohne Konto, bei dem nie eine Anfrage stattfindet.
 */
export const platformFetch: FetchFn = async (input, init) => {
	if (!isTauri()) return globalThis.fetch(input, init);
	if (!tauriFetch) {
		const modul = await import("@tauri-apps/plugin-http");
		tauriFetch = modul.fetch as FetchFn;
	}
	return tauriFetch(input, init);
};
