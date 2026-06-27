import type { Entry } from "./types";

/** Dauer eines Eintrags in Sekunden (laufende Eintraege bis `now`). */
export function durationSeconds(e: Entry, now = Date.now()): number {
	const end = e.endTs ?? now;
	return Math.max(0, Math.floor((end - e.startTs) / 1000));
}

/**
 * Stunden eines Eintrags. Abwesenheits-Eintraege zaehlen als Tagesanteil * hoursPerDay
 * (ganzer Tag = hoursPerDay, halber Tag = hoursPerDay/2); sonst aus der Dauer.
 */
export function entryHours(
	e: Entry,
	isAbsence: boolean,
	hoursPerDay: number,
	now = Date.now()
): number {
	if (isAbsence) return (e.dayFraction ?? 1) * hoursPerDay;
	return durationSeconds(e, now) / 3600;
}

export function roundHours(hours: number, step: number): number {
	if (!step || step <= 0) return hours;
	return Math.round(hours / step) * step;
}

/** "1:05:09" */
export function fmtHMS(totalSeconds: number): string {
	const s = Math.max(0, Math.floor(totalSeconds));
	const h = Math.floor(s / 3600);
	const m = Math.floor((s % 3600) / 60);
	const sec = s % 60;
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${h}:${pad(m)}:${pad(sec)}`;
}

/** Lokale Uhrzeit "HH:MM" eines Zeitstempels. */
export function fmtClock(ts: number): string {
	const d = new Date(ts);
	return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** Datum "YYYY-MM-DD" (lokal) eines Zeitstempels. */
export function fmtDate(ts: number): string {
	const d = new Date(ts);
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Stundenzahl deutsch formatiert, z.B. "4,5". */
export function fmtHours(h: number): string {
	return h.toLocaleString("de-DE", { minimumFractionDigits: 1, maximumFractionDigits: 2 });
}

/** "HH:MM" -> Minuten seit Mitternacht, oder null bei ungültiger Eingabe. */
export function clockToMin(t: string): number | null {
	const m = /^(\d{1,2}):(\d{2})$/.exec(t.trim());
	if (!m) return null;
	const h = Number(m[1]);
	const min = Number(m[2]);
	if (h > 23 || min > 59) return null;
	return h * 60 + min;
}

/** Minuten -> "HH:MM" (modulo 24h, rundet auf ganze Minuten). */
export function minToClock(min: number): string {
	const x = ((Math.round(min) % 1440) + 1440) % 1440;
	return `${String(Math.floor(x / 60)).padStart(2, "0")}:${String(x % 60).padStart(2, "0")}`;
}

/** Dauer in Stunden zwischen zwei "HH:MM"-Zeiten (über Mitternacht zählt +24h). */
export function durationHours(start: string, end: string): number {
	const a = clockToMin(start);
	const b = clockToMin(end);
	if (a == null || b == null) return 0;
	let d = b - a;
	if (d < 0) d += 1440;
	return d / 60;
}

/** Monatsname deutsch, z.B. "Juni 2026" aus "2026-06". */
export function monthLabel(monthKey: string): string {
	const [y, m] = monthKey.split("-").map(Number);
	const d = new Date(y, m - 1, 1);
	return d.toLocaleDateString("de-DE", { month: "long", year: "numeric" });
}
