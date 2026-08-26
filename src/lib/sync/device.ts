// Die dauerhafte Kennung dieses Geraets.
import { loadDevice, saveDevice } from "../store";
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
