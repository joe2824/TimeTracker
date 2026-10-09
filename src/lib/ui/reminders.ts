import { ensureNotificationPermission } from "../platform/notify";
import { notifyIfAllowed } from "./notifyIfAllowed";
import { app } from "../app.svelte";
import { reportReminderDate } from "../report/report";
import { clockToMin, fmtDate, minToClock, monthKey, noonTs, shiftMonthKey, stepDate, toTs } from "../time/time";

let timer: ReturnType<typeof setTimeout> | null = null;

// Die Erlaubnisfrage liegt in der Plattform-Schicht: im Browser hängt sie an
// einer Nutzerhandlung, auf dem Rechner nicht. Hier wird sie nur durchgereicht,
// damit die bisherigen Aufrufer unverändert bleiben.
export { ensureNotificationPermission };

/**
 * Millisekunden bis zur nächsten konfigurierten Erinnerungszeit, oder null.
 * Unlesbare Uhrzeiten ("24:00") fallen weg: ein NaN liesse setTimeout sofort
 * feuern und gleich wieder NaN planen.
 */
export function nextReminderDelay(times: string[], now = Date.now()): number | null {
	const today = fmtDate(now);
	let best = Infinity;
	for (const t of times) {
		const min = clockToMin(t);
		if (min === null) continue;
		const clock = minToClock(min);
		// Über den Kalender auf morgen, nicht per +24 h: an einem
		// Umstellungstag hat ein Tag 23 oder 25 Stunden.
		let ts = toTs(today, clock);
		if (ts <= now) ts = toTs(stepDate(today, 1), clock);
		if (!Number.isNaN(ts)) best = Math.min(best, ts - now);
	}
	return Number.isFinite(best) ? best : null;
}

let reportTimer: ReturnType<typeof setTimeout> | null = null;

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
	// Solange vorrücken, bis das Ziel in der Zukunft liegt. Ein einzelner Versuch
	// reichte nicht: bei grossem Vorlauf (reportReminderLeadDays wird nur nach unten
	// begrenzt) liegt auch der nächste Monat noch in der Vergangenheit – der delay
	// wurde negativ, setTimeout feuerte sofort, benachrichtigte und plante neu:
	// Dauerfeuer.
	let target = reportReminderDate(now, time, lead);
	const thisMonth = monthKey(now.getTime());
	for (let i = 0; i < 24 && target.getTime() <= now.getTime(); i++) {
		const next = shiftMonthKey(thisMonth, i + 1);
		target = reportReminderDate(new Date(noonTs(`${next}-01`)), time, lead);
	}
	if (target.getTime() <= now.getTime()) return; // unerreichbar -> gar nicht planen
	// setTimeout-delay ist auf ~24,8 Tage (2^31-1 ms) begrenzt. Bei größerem
	// Abstand kappen und beim Feuern prüfen, ob das Ziel wirklich erreicht ist –
	// sonst nur neu planen (keine verfrühte Benachrichtigung).
	const targetMs = target.getTime();
	const delay = Math.max(0, Math.min(targetMs - now.getTime(), 2 ** 31 - 1));
	reportTimer = setTimeout(async () => {
		if (Date.now() < targetMs) {
			scheduleReportReminder(); // war gekappt -> erneut planen
			return;
		}
		// Schon verschickt, etwa im Browser: dann gibt es nichts zu erinnern.
		if (!app.isReportSent(monthKey(targetMs))) {
			await notifyIfAllowed({
				title: "TimeTracker – Bericht senden",
				body: "Monatsende: Stundenbericht an die Vorgesetzten schicken nicht vergessen.",
				tag: "bericht"
			});
		}
		scheduleReportReminder();
	}, delay);
}

/** Plant die nächste Erinnerung. Bei jeder Änderung der Einstellungen erneut aufrufen. */
export function scheduleReminders(): void {
	if (timer) {
		clearTimeout(timer);
		timer = null;
	}
	const delay = nextReminderDelay(app.settings.reminderTimes);
	if (delay == null) return;
	timer = setTimeout(async () => {
		const running = app.running
			? `Aktuell läuft: ${app.activityName(app.running.activityId)}.`
			: "Kein Timer läuft.";
		await notifyIfAllowed({
			title: "TimeTracker – Zeiten eintragen",
			body: `Woran hast du gearbeitet? ${running}`,
			// Eine wiederholte Erinnerung ersetzt die vorherige, statt sich auf dem
			// Sperrbildschirm zu stapeln.
			tag: "erinnerung"
		});
		scheduleReminders();
	}, delay);
}
