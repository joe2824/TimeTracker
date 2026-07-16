// Reine Statistik-Logik fuer die Auswertungs-Card: keine Svelte-/Tauri-Abhaengigkeit,
// damit alles direkt testbar bleibt.
import type { Entry } from "./types";
import { durationSeconds, fmtDate, isWorkday } from "./time";

/** "YYYY-MM" fuer ein lokales Datum. */
function monthOf(d: Date): string {
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

/**
 * Gearbeitete Stunden je Tag UND Aktivitaet: "YYYY-MM-DD" -> activityId -> Stunden.
 * Abwesenheiten zaehlen NICHT mit: die Heatmap beantwortet "wie viel gearbeitet",
 * und Urlaub ist keine Projektzeit.
 */
export function dayActivityHours(
	entries: Entry[],
	absenceIds: Set<string>,
	now = Date.now()
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
		const h = durationSeconds(e, now) / 3600;
		perActivity.set(e.activityId, (perActivity.get(e.activityId) ?? 0) + h);
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
	now = Date.now()
): Map<string, number> {
	return sumPerDay(dayActivityHours(entries, absenceIds, now));
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
	const today = new Date(now);
	const currentMonth = monthOf(today);
	if (month > currentMonth) return 0;

	const daysInMonth = new Date(y, m, 0).getDate();
	const lastDay = month === currentMonth ? Math.min(today.getDate(), daysInMonth) : daysInMonth;

	let workdayCount = 0;
	for (let d = 1; d <= lastDay; d++) {
		if (isWorkday(new Date(y, m - 1, d).getTime(), workdays)) workdayCount++;
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

	// Auf den Montag der Woche gehen, in der der 1. Januar liegt.
	const first = new Date(year, 0, 1);
	const offsetToMonday = (first.getDay() + 6) % 7; // So(0) -> 6, Mo(1) -> 0
	const cursor = new Date(year, 0, 1 - offsetToMonday);

	// Volle Wochen bis der Cursor das Jahr verlaesst; Tage ausserhalb sind Filler.
	const weeks: HeatmapDay[][] = [];
	do {
		const week: HeatmapDay[] = [];
		for (let i = 0; i < 7; i++) {
			const inYear = cursor.getFullYear() === year;
			const date = fmtDate(cursor.getTime());
			const hours = inYear ? (byDay.get(date) ?? 0) : 0;
			week.push({ date, hours, level: inYear ? levelOf(hours) : 0, filler: !inYear });
			cursor.setDate(cursor.getDate() + 1);
		}
		weeks.push(week);
	} while (cursor.getFullYear() === year);
	return weeks;
}
