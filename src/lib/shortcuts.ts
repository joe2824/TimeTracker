// Globale Tastenkuerzel (auch wenn die App im Hintergrund/Tray laeuft).
// Pro Aktivitaet kann ein Accelerator hinterlegt werden, der den Timer startet.
import {
	register,
	unregisterAll,
	type ShortcutEvent
} from "@tauri-apps/plugin-global-shortcut";
import { toast } from "svelte-sonner";
import { app } from "./app.svelte";

/** Kurze, automatisch verschwindende Rückmeldung beim Start/Stop per Shortcut. */
function notifyShortcut(message: string) {
	if (app.settings.shortcutNotify) toast(message, { duration: 2000 });
}

/** Registriert alle Aktivitaets-Shortcuts neu. Bei jeder Aenderung aufrufen. */
export async function applyShortcuts(): Promise<void> {
	try {
		await unregisterAll();
	} catch {
		/* ignore */
	}
	const seen = new Set<string>();

	// Globaler Start/Stop-Hotkey für den zuletzt benutzten Timer.
	const toggle = app.settings.toggleShortcut?.trim();
	if (toggle) {
		seen.add(toggle);
		try {
			await register(toggle, (event: ShortcutEvent) => {
				if (event.state !== "Pressed") return;
				void app.toggleLast().then(() => {
					notifyShortcut(
						app.running
							? `▶ ${app.activityName(app.running.activityId)} gestartet`
							: "■ Timer gestoppt"
					);
				});
			});
		} catch (e) {
			console.error(`Toggle-Shortcut ${toggle} konnte nicht registriert werden`, e);
		}
	}

	for (const a of app.activities) {
		const acc = a.shortcut?.trim();
		if (!acc || a.archived || seen.has(acc)) continue;
		seen.add(acc);
		const id = a.id;
		try {
			await register(acc, (event: ShortcutEvent) => {
				// Nur beim Druck reagieren (nicht beim Loslassen).
				if (event.state !== "Pressed") return;
				void app.startActivity(id).then(() => {
					if (app.running?.activityId === id) {
						notifyShortcut(`▶ ${app.activityName(id)} gestartet`);
					}
				});
			});
		} catch (e) {
			console.error(`Shortcut ${acc} konnte nicht registriert werden`, e);
		}
	}
}

/**
 * Baut aus einem Tastendruck einen Tauri-Accelerator-String.
 * Gibt null zurueck, wenn nur Modifier gedrueckt wurden.
 */
export function acceleratorFromEvent(e: KeyboardEvent): string | null {
	const mods: string[] = [];
	if (e.ctrlKey) mods.push("Control");
	if (e.altKey) mods.push("Alt");
	if (e.shiftKey) mods.push("Shift");
	if (e.metaKey) mods.push("Super");

	let key: string | null = null;
	const code = e.code;
	let m: RegExpMatchArray | null;
	if ((m = code.match(/^Key([A-Z])$/))) key = m[1];
	else if ((m = code.match(/^Digit(\d)$/))) key = m[1];
	else if ((m = code.match(/^Numpad(\d)$/))) key = `Numpad${m[1]}`;
	else if ((m = code.match(/^(F\d{1,2})$/))) key = m[1];
	else if (code === "Space") key = "Space";
	else if (code === "Enter") key = "Enter";

	if (!key) return null;
	return [...mods, key].join("+");
}
