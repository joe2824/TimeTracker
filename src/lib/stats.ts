// Reine Statistik-Logik fuer die Auswertungs-Card: keine Svelte-/Tauri-Abhaengigkeit,
// damit alles direkt testbar bleibt.
import type { Entry } from "./types";
import { durationSeconds, fmtDate, monthKey, openEntryUntil } from "./time";
import { addCalendarDays, daysInMonth, isoDate, weekdayOfDate, zonedParts } from "./tz";
import { deductBreakFromDay } from "./breaks";

/**
 * Gearbeitete Stunden je Tag UND Aktivitaet: "YYYY-MM-DD" -> activityId -> Stunden.
 * Abwesenheiten zaehlen NICHT mit: die Heatmap beantwortet "wie viel gearbeitet",
 * und Urlaub ist keine Projektzeit.
 */
export function dayActivityHours(
	entries: Entry[],
	absenceIds: Set<string>,
	now = Date.now(),
	deductBreaks = false
): Map<string, Map<string, number>> {
	const byDay = new Map<string, Map<string, number>>();
	for (const e of entries) {
		if (absenceIds.has(e.activityId)) continue;
		const key = fmtDate(e.startTs);
		let perActivity = byDay.get(key);
		if (!perActivity) {
			perActivity = new Map();
			byDay.set(key, perActivity);
		}
		const h = durationSeconds(e, openEntryUntil(e, now)) / 3600;
		perActivity.set(e.activityId, (perActivity.get(e.activityId) ?? 0) + h);
	}
	// Der Abzug haengt an der Tagesarbeitszeit, also erst hier – wenn der Tag
	// vollstaendig ist.
	if (deductBreaks) {
		for (const [day, perActivity] of byDay) byDay.set(day, deductBreakFromDay(perActivity));
	}
	return byDay;
}

/**
 * Tagessummen aus einer bereits aufgeschluesselten Map.
 * Getrennt von dayWorkHours, damit ein Aufrufer, der die Aufschluesselung ohnehin
 * braucht (Tooltip), nicht ein zweites Mal ueber alle Eintraege laeuft.
 */
export function sumPerDay(detail: Map<string, Map<string, number>>): Map<string, number> {
	const byDay = new Map<string, number>();
	for (const [day, perActivity] of detail) {
		let sum = 0;
		for (const h of perActivity.values()) sum += h;
		byDay.set(day, sum);
	}
	return byDay;
}

/** Gearbeitete Stunden je Tag ("YYYY-MM-DD" -> Stunden). */
export function dayWorkHours(
	entries: Entry[],
	absenceIds: Set<string>,
	now = Date.now(),
	deductBreaks = false
): Map<string, number> {
	return sumPerDay(dayActivityHours(entries, absenceIds, now, deductBreaks));
}

/**
 * Soll-Stunden eines Monats = Werktage * hoursPerDay.
 *
 * Feiertage brauchen keine Sonderbehandlung: sie werden als Abwesenheit gebucht und
 * stecken damit auf der Ist-Seite (report.total) mit hoursPerDay drin – Soll und Ist
 * heben sich am Feiertag also auf.
 *
 * Im laufenden Monat zaehlen nur die Werktage BIS EINSCHLIESSLICH heute, sonst stuende
 * am Monatsanfang ein Minus fuer den ganzen Rest des Monats. Kuenftige Monate: 0.
 */
export function targetHours(
	month: string,
	workdays: number[],
	hoursPerDay: number,
	now = Date.now()
): number {
	const [y, m] = month.split("-").map(Number);
	if (!y || !m) return 0;
	const currentMonth = monthKey(now);
	if (month > currentMonth) return 0;

	// Alles ueber den Kalender, nicht ueber lokale Date-Konstruktion: sonst haengt
	// die Zahl der Werktage an der Zone des Geraets statt an der des Kontos.
	const dim = daysInMonth(y, m);
	const lastDay = month === currentMonth ? Math.min(zonedParts(now).day, dim) : dim;

	let workdayCount = 0;
	for (let d = 1; d <= lastDay; d++) {
		if (workdays.includes(weekdayOfDate(isoDate(y, m, d)))) workdayCount++;
	}
	return workdayCount * hoursPerDay;
}

export interface HeatmapDay {
	/** "YYYY-MM-DD" */
	date: string;
	hours: number;
	/** 0 = keine Stunden, sonst 1..4 (Quartile ueber alle Tage mit Stunden) */
	level: number;
	/** liegt ausserhalb des Jahres – Platzhalter, damit das Grid buendig bleibt */
	filler: boolean;
}

/**
 * Jahresraster fuer die Heatmap: Spalten = Wochen, Zeilen = Wochentage (Mo..So).
 *
 * Die Intensitaet ist der Anteil am staerksten Tag des Jahres, nicht ein Quartil:
 * Arbeitstage liegen dicht beieinander (meist 7–8 h), und Quartile wuerden diesen
 * engen Bereich ueber alle vier Stufen spreizen – 7,2 h saehe dann dramatisch
 * anders aus als 7,9 h. Am Maximum relativiert bleiben aehnliche Tage aehnlich.
 */
export function heatmapYear(year: number, byDay: Map<string, number>): HeatmapDay[][] {
	let max = 0;
	for (const [d, h] of byDay) {
		if (d.startsWith(`${year}-`) && h > max) max = h;
	}

	const levelOf = (h: number): number => {
		if (h <= 0 || max <= 0) return 0;
		return Math.min(4, Math.max(1, Math.ceil((h / max) * 4)));
	};

	// Auf den Montag der Woche gehen, in der der 1. Januar liegt. Reine
	// Kalenderrechnung auf "YYYY-MM-DD" – ein Date-Cursor haengt an der Zone des
	// Geraets und das Raster verrutschte dort um einen Tag.
	const jan1 = isoDate(year, 1, 1);
	const offsetToMonday = (weekdayOfDate(jan1) + 6) % 7; // So(0) -> 6, Mo(1) -> 0
	let cursor = addCalendarDays(jan1, -offsetToMonday);

	// Volle Wochen bis der Cursor das Jahr verlaesst; Tage ausserhalb sind Filler.
	const weeks: HeatmapDay[][] = [];
	const yearOf = (date: string) => Number(date.slice(0, 4));
	do {
		const week: HeatmapDay[] = [];
		for (let i = 0; i < 7; i++) {
			const inYear = yearOf(cursor) === year;
			const hours = inYear ? (byDay.get(cursor) ?? 0) : 0;
			week.push({ date: cursor, hours, level: inYear ? levelOf(hours) : 0, filler: !inYear });
			cursor = addCalendarDays(cursor, 1);
		}
		weeks.push(week);
	} while (yearOf(cursor) === year);
	return weeks;
}
