import type { Entry } from "./types";

/** "YYYY-MM" fuer einen Zeitstempel (Lokalzeit). */
export function monthKey(ts: number): string {
	const d = new Date(ts);
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

/**
 * Der Vormonat als "YYYY-MM".
 *
 * Ueber den Monatsersten rechnen, nicht per setMonth() auf dem heutigen Datum:
 * am 31. rollt "31. Juni" auf den 1. Juli, `setMonth(-1)` lieferte dort also den
 * AKTUELLEN Monat. Folge waren ein nie geladener Vormonat und ein Bericht-Hinweis,
 * der ausgerechnet am Monatsletzten verschwand.
 */
export function prevMonthKey(now = Date.now()): string {
	const d = new Date(now);
	return monthKey(new Date(d.getFullYear(), d.getMonth() - 1, 1).getTime());
}

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

/**
 * Ende eines offenen Eintrags (endTs === null) fuer Auswertungen: gekappt auf
 * das Ende SEINES Tages, nie unbegrenzt bis `now`.
 *
 * Ein vergessener offener Eintrag in einem alten Monat zaehlte sonst bis
 * `now` weiter – erreichbar, weil beim Start nur der aktuelle und der
 * Vormonat geladen werden und eine aeltere offene Zeile niemand schliesst.
 * Ein laufender Timer wird an Mitternacht geteilt, kann also nie ueber
 * seinen eigenen Tag hinausreichen – dort wird gekappt.
 */
export function openEntryUntil(e: Entry, now: number): number {
	return e.endTs === null ? Math.min(now, startOfNextDay(e.startTs)) : now;
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

/** Eine Minute in Millisekunden – Schrittweite fuer `quantize`. */
export const MINUTE_MS = 60_000;

/**
 * Einen Zeitstempel auf ein Vielfaches von `stepMs` abrunden.
 *
 * Gedacht fuer Auswertungen, die an `app.now` haengen. Der tickt im
 * Sekundentakt, damit die laufende Uhr laeuft – ein Jahresschnitt oder eine
 * Heatmap aendert sich dadurch aber nicht sichtbar. Auf Minuten gerundet bleibt
 * der Wert 59 von 60 Sekunden GLEICH, und einen unveraenderten Wert gibt Svelte
 * nicht weiter: die dahinterliegende Rechnung laeuft dann einmal je Minute statt
 * sechzigmal, samt allem, was daran haengt (Diagramme, Wochenraster).
 */
export function quantize(ts: number, stepMs: number): number {
	return Math.floor(ts / stepMs) * stepMs;
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
 * Einen minutengenau bearbeiteten Zeitpunkt auf den gespeicherten zurueckfuehren,
 * solange die MINUTE dieselbe geblieben ist.
 *
 * Der Eintrags-Dialog zeigt "HH:MM" und baut daraus wieder einen Zeitstempel –
 * die Sekunden fallen dabei weg. Timer-Eintraege haben aber welche: ein Wechsel
 * setzt das Ende des einen exakt auf den Start des naechsten (…14:00:22). Wer
 * so einen Eintrag anfasst, verschiebt seinen Start ungewollt auf 14:00:00 und
 * ragt damit 22 Sekunden in den Vorgaenger – die Ueberschneidungs-Regel weist
 * das Speichern ab, und zwar fuer ein Feld, das der Nutzer gar nicht angefasst
 * hat. Betroffen ist jeder Eintrag, der an einen anderen anstoesst, also der
 * Normalfall nach einem Aktivitaetswechsel.
 *
 * Der Preis ist ein bewusster: wer 14:00 tippt und exakt 14:00:00 meint, bekommt
 * die alten 22 Sekunden zurueck. Das Feld kann diesen Unterschied ohnehin nicht
 * ausdruecken.
 *
 * @param original der gespeicherte Zeitpunkt, oder null bei einem neuen Eintrag
 */
export function keepSeconds(ts: number, original: number | null): number {
	if (original === null || Number.isNaN(ts)) return ts;
	return Math.floor(ts / 60000) === Math.floor(original / 60000) ? original : ts;
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

/**
 * Mitternacht des Folgetags. setHours(24,…) statt +24h: an DST-Tagen hat ein Tag
 * 23 oder 25 Stunden, eine feste Addition traefe die Grenze dort nicht.
 */
export function startOfNextDay(ts: number): number {
	const d = new Date(ts);
	d.setHours(24, 0, 0, 0);
	return d.getTime();
}

/**
 * Zerlegt [startTs, endTs] an Mitternacht in Tagesstuecke.
 *
 * Ein Timer ueber Mitternacht muss dort enden und am neuen Tag fortgesetzt
 * werden – sonst zaehlt die Zeit nach 00:00 zum Vortag, und an einer
 * Monatsgrenze landet sie sogar in der falschen Monatsdatei.
 *
 * Ein Zeitraum innerhalb eines Tages ergibt genau ein Stueck.
 */
export function splitAtMidnight(
	startTs: number,
	endTs: number
): { startTs: number; endTs: number }[] {
	const parts: { startTs: number; endTs: number }[] = [];
	let cur = startTs;
	while (cur < endTs) {
		const end = Math.min(startOfNextDay(cur), endTs);
		parts.push({ startTs: cur, endTs: end });
		cur = end;
	}
	return parts.length > 0 ? parts : [{ startTs, endTs }];
}

/**
 * Hinweistext, wenn eine Spanne ueber Mitternacht geht – sonst null.
 *
 * Ueber Mitternacht entsteht ein Eintrag JE TAG. Das gehoert vor dem Speichern
 * gesagt, nicht erst hinterher in der Liste entdeckt.
 *
 * Liegt hier und nicht in einer Komponente, weil dieselbe Regel an drei Stellen
 * gilt: Timer-Start im Hauptfenster, Timer-Start im Tray und der manuelle
 * Eintrag. Zweimal hat der Hinweis schlicht gefehlt, weil jede Stelle ihren
 * eigenen Text baute.
 */
export function midnightSplitHint(startTs: number, endTs: number): string | null {
	const parts = splitAtMidnight(startTs, endTs).length;
	return parts > 1 ? `über Mitternacht, wird in ${parts} Einträge geteilt` : null;
}

/** Datum deutsch mit Wochentag, z.B. "Do., 16.07.2026" – fuer Meldungen und Tooltips. */
export function fmtDateHuman(ts: number): string {
	return new Date(ts).toLocaleDateString("de-DE", {
		weekday: "short",
		day: "2-digit",
		month: "2-digit",
		year: "numeric"
	});
}

/** Monatsname deutsch, z.B. "Juni 2026" aus "2026-06". */
export function monthLabel(monthKey: string): string {
	const [y, m] = monthKey.split("-").map(Number);
	const d = new Date(y, m - 1, 1);
	return d.toLocaleDateString("de-DE", { month: "long", year: "numeric" });
}
