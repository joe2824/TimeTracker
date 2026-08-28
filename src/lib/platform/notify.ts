import { isTauri } from "./env";

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
			const { sendNotification } = await import("@tauri-apps/plugin-notification");
			sendNotification({ title: opts.title, body: opts.body });
			return;
		}
		if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
		new Notification(opts.title, { body: opts.body, tag: opts.tag, icon: "/icon-256.png" });
	} catch {
		// Eine nicht zustellbare Erinnerung ist aergerlich, aber kein Grund, den
		// Aufrufer scheitern zu lassen - der zaehlt sonst seine Zeit nicht weiter.
	}
}
