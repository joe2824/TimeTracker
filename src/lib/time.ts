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

/**
 * Epoch-ms fuer "YYYY-MM-DD" + "HH:MM" in Lokalzeit. NaN bei ungueltiger Eingabe.
 */
export function toTs(date: string, time: string): number {
	return new Date(`${date}T${time}:00`).getTime();
}

/**
 * Epoch-ms fuer die Tagesmitte eines "YYYY-MM-DD".
 *
 * 12:00 statt 00:00, weil ein Tag an DST-Grenzen um Mitternacht auf den Vortag
 * kippen kann. Der Mittag haelt in jeder Zeitzone Abstand zu beiden Raendern.
 * Abwesenheiten haengen genau daran (start == end == Tagesmitte).
 */
export function noonTs(date: string): number {
	return toTs(date, "12:00");
}

/** Verschiebt ein "YYYY-MM-DD"-Datum um `delta` Tage – mit Monats-/Jahresübergang. */
export function stepDate(date: string, delta: number): string {
	const d = new Date(noonTs(date));
	if (Number.isNaN(d.getTime())) return date;
	d.setDate(d.getDate() + delta);
	return fmtDate(d.getTime());
}

/** Ist der Tag von `ts` ein regulärer Arbeitstag? (workdays: Wochentagsnummern 0=So..6=Sa) */
export function isWorkday(ts: number, workdays: number[]): boolean {
	return workdays.includes(new Date(ts).getDay());
}

/**
 * Tages-Mitten (12:00 lokal) aller Tage eines Ganztags-Termins.
 * Outlook liefert das Ende exklusiv (nächster Tag 00:00), daher Iteration bis < Ende-Mitternacht.
 * Fällt immer auf mindestens den Starttag zurück (z. B. wenn Ende <= Start).
 */
export function allDayNoons(startTs: number, endExclusiveTs: number): number[] {
	const out: number[] = [];
	const day = new Date(startTs);
	day.setHours(12, 0, 0, 0);
	const endMidnight = new Date(endExclusiveTs);
	endMidnight.setHours(0, 0, 0, 0);
	while (day.getTime() < endMidnight.getTime()) {
		out.push(day.getTime());
		day.setDate(day.getDate() + 1);
	}
	if (out.length === 0) {
		const s = new Date(startTs);
		s.setHours(12, 0, 0, 0);
		out.push(s.getTime());
	}
	return out;
}

/** Stundenzahl deutsch formatiert, z.B. "4,5". */
export function fmtHours(h: number): string {
	return h.toLocaleString("de-DE", { minimumFractionDigits: 1, maximumFractionDigits: 2 });
}

/** Stundenzahl als Zeitformat "H:MM", z.B. 7.5 -> "7:30", 40 -> "40:00". */
export function fmtHoursClock(hours: number): string {
	const totalMin = Math.round(hours * 60);
	const sign = totalMin < 0 ? "-" : "";
	const abs = Math.abs(totalMin);
	return `${sign}${Math.floor(abs / 60)}:${String(abs % 60).padStart(2, "0")}`;
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

/**
 * Uhrzeit-Eingabe flexibel parsen und auf "HH:MM" normalisieren. Akzeptiert
 * "18:00", "1800", "830", "8", "18.30", "18,30", "18h30". Null bei ungültiger Eingabe.
 */
export function parseClock(input: string): string | null {
	const t = input.trim();
	if (!t) return null;
	let h: number;
	let min: number;
	const sep = /^(\d{1,2})[:.,h](\d{1,2})$/i.exec(t);
	if (sep) {
		h = Number(sep[1]);
		min = Number(sep[2]);
	} else if (/^\d+$/.test(t)) {
		if (t.length <= 2) {
			h = Number(t);
			min = 0;
		} else if (t.length === 3) {
			h = Number(t.slice(0, 1));
			min = Number(t.slice(1));
		} else if (t.length === 4) {
			h = Number(t.slice(0, 2));
			min = Number(t.slice(2));
		} else {
			return null;
		}
	} else {
		return null;
	}
	if (h > 23 || min > 59) return null;
	return `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
}

/**
 * Stunden-Eingabe parsen. Akzeptiert Dezimal ("7,5" / "7.5", unbegrenzt – z.B. 80
 * für Monatspauschalen), Uhrzeit-Format mit Doppelpunkt ("7:30", Stunden 0–23) und
 * vierstellige HHMM-Eingabe ohne Trenner ("0741" = 7:41, "1230" = 12:30). Im
 * Uhrzeit-Format wird einstellige Minutenangabe als 0–9 Minuten gelesen ("7:5" = 7:05).
 * Liefert Dezimalstunden oder null bei ungültiger Eingabe.
 */
export function parseHours(input: string): number | null {
	const t = input.trim();
	if (!t) return null;
	const colon = /^(\d{1,2}):(\d{1,2})$/.exec(t);
	if (colon) {
		const h = Number(colon[1]);
		const min = Number(colon[2]);
		if (h > 23 || min > 59) return null;
		return h + min / 60;
	}
	// Vierstellige HHMM-Eingabe ("0741" -> 7:41). Vierstellige Stundenzahlen wären
	// als Tagesdauer ohnehin unsinnig, daher als Uhrzeit interpretieren.
	const hhmm = /^(\d{2})(\d{2})$/.exec(t);
	if (hhmm) {
		const h = Number(hhmm[1]);
		const min = Number(hhmm[2]);
		if (h <= 23 && min <= 59) return h + min / 60;
	}
	const n = Number(t.replace(",", "."));
	return Number.isFinite(n) && n >= 0 ? n : null;
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
