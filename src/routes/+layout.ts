// Tauri hat keinen Node-Server fuer echtes SSR, deshalb adapter-static mit
// Rueckfall auf index.html - die Anwendung ist eine reine Seitenanwendung.
// Siehe https://svelte.dev/docs/kit/single-page-apps
export const ssr = false;

import { isTauri } from "$lib/platform/env";
import { useBrowserStorage } from "$lib/platform/fs";

/**
 * Die Ablage waehlen, BEVOR irgendetwas Daten liest.
 *
 * Hier und nicht in der Seite: dieses Modul laeuft vor jeder Komponente. Stuende
 * die Zeile weiter unten, haette der erste Ladevorgang schon ins Dateisystem
 * gegriffen - das es im Browser nicht gibt.
 */
if (!isTauri()) useBrowserStorage();
