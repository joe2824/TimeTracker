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

let reportTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Erinnerungs-Datum für den Monat von `d`: letzter Werktag, optional `lead`
 * Werktage davor, auf `time` (HH:MM) gesetzt.
 */
function reportReminderDate(d: Date, time: string, lead: number): Date {
	const [h, m] = time.split(":").map(Number);
	const day = new Date(d.getFullYear(), d.getMonth() + 1, 0); // letzter Tag des Monats
	const stepBackToWeekday = () => {
		while (day.getDay() === 0 || day.getDay() === 6) day.setDate(day.getDate() - 1);
	};
	stepBackToWeekday();
	// `lead` weitere Werktage zurückgehen.
	for (let i = 0; i < Math.max(0, lead); i++) {
		day.setDate(day.getDate() - 1);
		stepBackToWeekday();
	}
	day.setHours(h || 16, m || 0, 0, 0);
	return day;
}

/** Plant die Berichts-Erinnerung am letzten Werktag des Monats. */
export function scheduleReportReminder(): void {
	if (reportTimer) {
		clearTimeout(reportTimer);
		reportTimer = null;
	}
	if (!app.settings.reportReminderEnabled) return;
	const now = new Date();
	const time = app.settings.reportReminderTime;
	const lead = app.settings.reportReminderLeadDays;
	let target = reportReminderDate(now, time, lead);
	if (target.getTime() <= now.getTime()) {
		target = reportReminderDate(new Date(now.getFullYear(), now.getMonth() + 1, 1), time, lead);
	}
	// setTimeout-delay ist auf ~24,8 Tage (2^31-1 ms) begrenzt. Bei größerem
	// Abstand kappen und beim Feuern prüfen, ob das Ziel wirklich erreicht ist –
	// sonst nur neu planen (keine verfrühte Benachrichtigung).
	const targetMs = target.getTime();
	const delay = Math.min(targetMs - now.getTime(), 2 ** 31 - 1);
	reportTimer = setTimeout(async () => {
		if (Date.now() < targetMs) {
			scheduleReportReminder(); // war gekappt -> erneut planen
			return;
		}
		if (await ensureNotificationPermission()) {
			sendNotification({
				title: "TimeTracker – Bericht senden",
				body: "Monatsende: Stundenbericht an den Chef schicken nicht vergessen."
			});
		}
		scheduleReportReminder();
	}, delay);
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
