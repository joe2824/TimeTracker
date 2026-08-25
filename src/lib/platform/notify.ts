// Benachrichtigungen.
//
// Auf dem Rechner ueber Tauri, im Browser ueber die eingebaute Schnittstelle.
// Beides sieht fuer den Aufrufer gleich aus, weil der Unterschied ihn nichts
// angeht: er will eine Erinnerung zeigen, nicht wissen, wer sie zustellt.
//
// Der Sinn im Browser ist ein anderer als auf dem Rechner. Dort ist die
// Erinnerung Beiwerk - man sieht das Fenster ohnehin. Auf dem Handy ist sie oft
// der einzige Grund, die Anwendung ueberhaupt zu oeffnen.
import { isTauri } from "./env";

/**
 * Um Erlaubnis fragen - aber nur, wenn es etwas zu fragen gibt.
 *
 * Browser verlangen fuer diese Frage eine Nutzerhandlung; unaufgefordert beim
 * Start gefragt, lehnen manche sie stillschweigend ab und fragen nie wieder.
 * Der Aufrufer soll sie deshalb an eine Handlung haengen - etwa das Einschalten
 * der Erinnerungen.
 */
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
	/**
	 * Gleiche Kennung ersetzt die vorherige Meldung, statt eine zweite zu zeigen.
	 *
	 * Ohne das stapeln sich bei einer wiederholten Erinnerung mehrere gleiche
	 * Meldungen auf dem Sperrbildschirm.
	 */
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
