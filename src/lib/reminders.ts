import {
	isPermissionGranted,
	requestPermission,
	sendNotification
} from "@tauri-apps/plugin-notification";
import { app } from "./app.svelte";

let timer: ReturnType<typeof setTimeout> | null = null;

export async function ensureNotificationPermission(): Promise<boolean> {
	let granted = await isPermissionGranted();
	if (!granted) granted = (await requestPermission()) === "granted";
	return granted;
}

/** Millisekunden bis zur naechsten konfigurierten Erinnerungszeit. */
function nextReminderDelay(times: string[]): number | null {
	if (!times.length) return null;
	const now = new Date();
	let best = Infinity;
	for (const t of times) {
		const [h, m] = t.split(":").map(Number);
		if (Number.isNaN(h) || Number.isNaN(m)) continue;
		const d = new Date(now);
		d.setHours(h, m, 0, 0);
		if (d.getTime() <= now.getTime()) d.setDate(d.getDate() + 1);
		best = Math.min(best, d.getTime() - now.getTime());
	}
	return best === Infinity ? null : best;
}

/** Plant die naechste Erinnerung. Bei jeder Aenderung der Einstellungen erneut aufrufen. */
export function scheduleReminders(): void {
	if (timer) {
		clearTimeout(timer);
		timer = null;
	}
	const delay = nextReminderDelay(app.settings.reminderTimes);
	if (delay == null) return;
	timer = setTimeout(async () => {
		if (await ensureNotificationPermission()) {
			const running = app.running
				? `Aktuell läuft: ${app.activityName(app.running.activityId)}.`
				: "Kein Timer läuft.";
			sendNotification({
				title: "TimeTracker – Zeiten eintragen",
				body: `Woran hast du gearbeitet? ${running}`
			});
		}
		scheduleReminders();
	}, delay);
}
