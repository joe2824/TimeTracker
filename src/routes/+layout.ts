// Tauri hat keinen Node-Server für echtes SSR, deshalb adapter-static mit
// Rückfall auf index.html - die Anwendung ist eine reine Seitenanwendung.
// Siehe https://svelte.dev/docs/kit/single-page-apps
export const ssr = false;

import { isTauri } from "$lib/platform/env";
import { useBrowserStorage } from "$lib/platform/fs";

/** Die Ablage wählen, BEVOR irgendetwas Daten liest. */
if (!isTauri()) useBrowserStorage();
