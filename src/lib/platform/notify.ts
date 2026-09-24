import { isTauri } from "./env";
import { logWarn } from "../log";

/** Um Erlaubnis fragen - aber nur, wenn es etwas zu fragen gibt. */
export async function ensureNotificationPermission(): Promise<boolean> {
	if (isTauri()) {
		const { isPermissionGranted, requestPermission } = await import(
			"@tauri-apps/plugin-notification"
		);
		return (await isPermissionGranted()) || (await requestPermission()) === "granted";
	}
	if (typeof Notification === "undefined") return false;
	if (Notification.permission === "granted") return true;
	if (Notification.permission === "denied") return false;
	return (await Notification.requestPermission()) === "granted";
}

export interface NotifyOptions {
	title: string;
	body: string;
	/** Gleiche Kennung ersetzt die vorherige Meldung, statt eine zweite zu zeigen. */
	tag?: string;
}

export async function notify(opts: NotifyOptions): Promise<void> {
	try {
		if (isTauri()) {
			// Über Rust statt sendNotification: nur so bekommt die Meldung unter
			// Windows ein Klick-Ziel, das die App öffnet (siehe toast.rs).
			const { invoke } = await import("@tauri-apps/api/core");
			await invoke("show_notification", { title: opts.title, body: opts.body, tag: opts.tag });
			return;
		}
		if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
		const n = new Notification(opts.title, { body: opts.body, tag: opts.tag, icon: "/icon-256.png" });
		n.onclick = () => {
			window.focus();
			n.close();
		};
	} catch (e) {
		// Eine nicht zustellbare Erinnerung ist ärgerlich, aber kein Grund, den
		// Aufrufer scheitern zu lassen - der zählt sonst seine Zeit nicht weiter.
		logWarn("Benachrichtigung nicht zugestellt", e);
	}
}
