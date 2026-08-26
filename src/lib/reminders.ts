import { ensureNotificationPermission, notify } from "./platform/notify";
import { app } from "./app.svelte";
import { reportReminderDate } from "./report";
import { fmtDate, stepDate, toTs } from "./time";
import { wallToTs, zonedParts } from "./tz";

let timer: ReturnType<typeof setTimeout> | null = null;

// Die Erlaubnisfrage liegt in der Plattform-Schicht: im Browser haengt sie an
// einer Nutzerhandlung, auf dem Rechner nicht. Hier wird sie nur durchgereicht,
// damit die bisherigen Aufrufer unveraendert bleiben.
export { ensureNotificationPermission };

/** Millisekunden bis zur naechsten konfigurierten Erinnerungszeit. */
function nextReminderDelay(times: string[]): number | null {
	if (!times.length) return null;
	const now = Date.now();
	const today = fmtDate(now);
	let best = Infinity;
	for (const t of times) {
		const [h, m] = t.split(":").map(Number);
		if (Number.isNaN(h) || Number.isNaN(m)) continue;
		const clock = `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
		// Ueber den Kalender auf morgen, nicht per +24 h: an einem
		// Umstellungstag hat ein Tag 23 oder 25 Stunden.
		let ts = toTs(today, clock);
		if (ts <= now) ts = toTs(stepDate(today, 1), clock);
		best = Math.min(best, ts - now);
	}
	return best === Infinity ? null : best;
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
	// Solange vorruecken, bis das Ziel in der Zukunft liegt. Ein einzelner Versuch
	// reichte nicht: bei grossem Vorlauf (reportReminderLeadDays wird nur nach unten
	// begrenzt) liegt auch der naechste Monat noch in der Vergangenheit – der delay
	// wurde negativ, setTimeout feuerte sofort, benachrichtigte und plante neu:
	// Dauerfeuer.
	let target = reportReminderDate(now, time, lead);
	for (let i = 0; i < 24 && target.getTime() <= now.getTime(); i++) {
		// Den Monatsersten ueber die Kalenderrechnung bilden: eine lokale
		// Date-Konstruktion haengt an der Zone des Geraets.
		const p = zonedParts(now.getTime());
		const idx = p.year * 12 + (p.month - 1) + 1 + i;
		target = reportReminderDate(
			new Date(wallToTs(Math.floor(idx / 12), (idx % 12) + 1, 1)),
			time,
			lead
		);
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
		if (await ensureNotificationPermission()) {
			await notify({
				title: "TimeTracker – Bericht senden",
				body: "Monatsende: Stundenbericht an die Vorgesetzten schicken nicht vergessen.",
				tag: "bericht"
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
			await notify({
				title: "TimeTracker – Zeiten eintragen",
				body: `Woran hast du gearbeitet? ${running}`,
				// Eine wiederholte Erinnerung ersetzt die vorherige, statt sich auf dem
				// Sperrbildschirm zu stapeln.
				tag: "erinnerung"
			});
		}
		scheduleReminders();
	}, delay);
}
