// Die dauerhafte Kennung dieses Geraets.
import { loadDevice, updateDevice } from "../store";
import { logInfo } from "../log";

let cached: string | null = null;

/** Die Kennung dieses Geraets, angelegt beim ersten Aufruf. */
export async function deviceId(): Promise<string> {
	if (cached) return cached;
	const stored = await loadDevice();
	if (stored?.id) {
		cached = stored.id;
		return cached;
	}
	let id: string = crypto.randomUUID();
	await updateDevice((info) => {
		// Zwischen Lesen und Schreiben kann eine andere Stelle eine Kennung
		// angelegt haben - dann gilt deren, sonst haetten zwei Aufrufe zwei.
		if (info?.id) {
			id = info.id;
			return null;
		}
		return { ...(info ?? {}), id };
	});
	cached = id;
	logInfo("Geraetekennung angelegt", { id });
	return id;
}

/** Nur fuer Tests: den Puffer vergessen. */
export function resetDeviceForTests(): void {
	cached = null;
}
