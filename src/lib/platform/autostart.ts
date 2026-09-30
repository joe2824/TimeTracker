// Mit der Anmeldung am Rechner starten - nur in der Desktop-Anwendung.
import { enable, disable, isEnabled } from "@tauri-apps/plugin-autostart";
import { capabilities } from "./env";

/** Autostart ein- oder ausschalten. Im Browser ohne Wirkung; Fehler gehen an den Aufrufer. */
export async function setAutostart(on: boolean): Promise<void> {
	if (!capabilities.autostart) return;
	if (on) {
		if (!(await isEnabled())) await enable();
	} else if (await isEnabled()) {
		await disable();
	}
}

/** Ob der Autostart gerade aktiv ist; im Browser immer false. */
export async function autostartEnabled(): Promise<boolean> {
	return capabilities.autostart ? isEnabled() : false;
}
