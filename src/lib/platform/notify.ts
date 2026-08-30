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

let actionListenerInstalled = false;

/**
 * Richtet den Klick-Listener ein, damit ein Klick auf eine System-Benachrichtigung
 * (unter Windows, macOS oder Linux) die App in den Vordergrund holt.
 */
export async function installNotificationClickListener(): Promise<() => void> {
	if (!isTauri() || actionListenerInstalled) return () => {};
	actionListenerInstalled = true;
	try {
		const { onAction } = await import("@tauri-apps/plugin-notification");
		const { invoke } = await import("@tauri-apps/api/core");
		const unlisten = await onAction(() => {
			void invoke("show_main_window").catch(() => {});
		});
		return () => {
			actionListenerInstalled = false;
			void unlisten.unregister();
		};
	} catch {
		actionListenerInstalled = false;
		return () => {};
	}
}

export async function notify(opts: NotifyOptions): Promise<void> {
	try {
		if (isTauri()) {
			void installNotificationClickListener();
			const { sendNotification } = await import("@tauri-apps/plugin-notification");
			sendNotification({
				title: opts.title,
				body: opts.body,
				autoCancel: true
			});
			return;
		}
		if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
		const n = new Notification(opts.title, { body: opts.body, tag: opts.tag, icon: "/icon-256.png" });
		n.onclick = () => {
			window.focus();
			n.close();
		};
	} catch {
		// Eine nicht zustellbare Erinnerung ist aergerlich, aber kein Grund, den
		// Aufrufer scheitern zu lassen - der zaehlt sonst seine Zeit nicht weiter.
	}
}
