// Tauri hat keinen Node-Server fuer echtes SSR, deshalb adapter-static mit
// Rueckfall auf index.html - die Anwendung ist eine reine Seitenanwendung.
// Siehe https://svelte.dev/docs/kit/single-page-apps
export const ssr = false;

import { isTauri } from "$lib/platform/env";
import { useBrowserStorage } from "$lib/platform/fs";

/** Die Ablage waehlen, BEVOR irgendetwas Daten liest. */
if (!isTauri()) useBrowserStorage();
