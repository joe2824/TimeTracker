// Den anderen Fenstern sagen, dass sich die Daten geaendert haben.
//
// Haupt- und Tray-Fenster sind zwei getrennte Webviews mit je eigenem Zustand;
// sie teilen sich nur die Dateien. Wer schreibt, muss es also sagen - sonst
// zeigt das andere Fenster den Stand von vorhin.
import { isTauri } from "./env";

/** Welches Fenster hier laeuft. Der Absender ignoriert seinen eigenen Ruf. */
export function windowName(): "tray" | "main" {
	if (typeof location === "undefined") return "main";
	return location.pathname.startsWith("/tray") ? "tray" : "main";
}

export interface DataChanged {
	from: "tray" | "main" | "sync";
}

/**
 * Ein "data-reload" an alle Fenster. Im Browser gibt es nur eines - dort still.
 *
 * Wirft nie: das ist eine Annehmlichkeit, kein Arbeitsschritt.
 */
export async function notifyDataChanged(payload?: Partial<DataChanged>): Promise<void> {
	if (!isTauri()) return;
	try {
		const { emit } = await import("@tauri-apps/api/event");
		// Tauri stellt auch dem Absender zu. Ohne die Kennung antwortete das
		// Hauptfenster auf seinen eigenen Ruf und drehte sich im Kreis.
		await emit("data-reload", { from: payload?.from ?? windowName() } satisfies DataChanged);
	} catch {
		// Kein Ereigniskanal - dann aktualisiert das andere Fenster eben beim
		// naechsten eigenen Anlass.
	}
}
