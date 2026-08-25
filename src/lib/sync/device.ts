// Die dauerhafte Kennung dieses Geraets.
//
// Sie beantwortet beim Abgleich die Frage "wer hat das zuletzt geschrieben" –
// und spaeter, welches Geraet der Server kennt und welches widerrufen wurde.
// Sie ueberdauert Neustarts und Updates, aber nicht das Loeschen des
// Datenordners; dann ist es aus Sicht des Servers schlicht ein neues Geraet.
import { loadDevice, saveDevice } from "../store";
import { logInfo } from "../log";

let cached: string | null = null;

/**
 * Die Kennung dieses Geraets, angelegt beim ersten Aufruf.
 *
 * Gepuffert, weil beide Fenster sie bei jedem Schreibvorgang brauchen. Der
 * Puffer ist unkritisch: die Kennung aendert sich zu Lebzeiten des Prozesses
 * nicht, und beide Fenster lesen dieselbe Datei.
 */
export async function deviceId(): Promise<string> {
	if (cached) return cached;
	const stored = await loadDevice();
	if (stored?.id) {
		cached = stored.id;
		return cached;
	}
	const id = crypto.randomUUID();
	await saveDevice({ id });
	cached = id;
	logInfo("Geraetekennung angelegt", { id });
	return id;
}

/** Nur fuer Tests: den Puffer vergessen. */
export function resetDeviceForTests(): void {
	cached = null;
}
