import type { Activity, Entry } from "./types";
import { addCalendarDays, daysInMonth, isoDate, wallToTs, weekdayOfDate, zonedParts } from "./tz";
import { DEFAULT_SUBJECT } from "./types";
import { deductBreakFromDay } from "./breaks";
import {
	entryHours,
	fmtDate,
	fmtHoursClock,
	isWorkday,
	monthLabel,
	openEntryUntil,
	roundHours
} from "./time";

/** Betreff aus der Vorlage bauen. Platzhalter: {month}, {name}. */
export function reportSubject(template: string, label: string, name: string): string {
	const trimmedName = name.trim();
	const tpl = template.trim() || DEFAULT_SUBJECT;
	const withName = trimmedName && !tpl.includes("{name}") ? `${tpl} – {name}` : tpl;
	return withName
		.replaceAll("{month}", label)
		.replaceAll("{name}", trimmedName)
		.replace(/\s*[–-]\s*$/, "")
		.replace(/^\s*[–-]\s*/, "")
		.replace(/\s{2,}/g, " ")
		.trim();
}

export interface ReportRow {
	activityId: string;
	name: string;
	hours: number;
	isAbsence: boolean;
}

export interface MonthReport {
	month: string;
	label: string;
	rows: ReportRow[];
	total: number;
	absenceHours: number;
	workHours: number;
	/** Wie viel Pause insgesamt abgezogen wurde (0 = Abzug aus). */
	breakHours: number;
}

/**
 * Aggregiert die Eintraege eines Monats zu einer Zeile je Aktivitaet.
 * Es erscheinen ALLE nicht-archivierten Aktivitaeten (auch mit 0 Stunden),
 * jeweils auf `step` Stunden gerundet.
 *
 * `deductBreaks` zieht die Pause JE TAG ab, nie auf der Monatssumme - die Regel
 * haengt an der Tagesarbeitszeit (siehe breaks.ts).
 */
export function buildReport(
	month: string,
	activities: Activity[],
	entries: Entry[],
	step: number,
	hoursPerDay: number,
	workdays?: number[],
	now = Date.now(),
	deductBreaks = false
): MonthReport {
	const absenceIds = new Set(activities.filter((a) => a.isAbsence).map((a) => a.id));

	// Endzeitpunkt fuer die Stundenrechnung – siehe openEntryUntil() in time.ts.
	const until = (e: Entry) => openEntryUntil(e, now);

	// Abwesenheiten an Nicht-Arbeitstagen (z. B. Wochenende) zaehlen nicht mit –
	// weder als Abwesenheitsstunden noch als Ganztags-Sperre.
	const isCountedAbsence = (e: Entry) =>
		absenceIds.has(e.activityId) && (!workdays || isWorkday(e.startTs, workdays));

	// Tage mit Ganztags-Abwesenheit: an diesen Tagen zaehlen Projektzeiten nicht.
	const fullDayAbsenceDays = new Set<string>();
	for (const e of entries) {
		if (isCountedAbsence(e) && (e.dayFraction ?? 1) >= 1) {
			fullDayAbsenceDays.add(fmtDate(e.startTs));
		}
	}

	const hoursByActivity = new Map<string, number>();
	const add = (id: string, h: number) =>
		hoursByActivity.set(id, (hoursByActivity.get(id) ?? 0) + h);

	// Projektzeit erst je TAG sammeln: der Pausenabzug haengt an der
	// Tagesarbeitszeit. Abwesenheiten laufen daran vorbei – auf einen Urlaubstag
	// gibt es keine Pause.
	const workByDay = new Map<string, Map<string, number>>();
	for (const e of entries) {
		const isAbs = absenceIds.has(e.activityId);
		// Abwesenheit an einem Nicht-Arbeitstag komplett ignorieren.
		if (isAbs && workdays && !isWorkday(e.startTs, workdays)) continue;
		// Projekteintraege an Ganztags-Abwesenheitstagen ignorieren.
		if (!isAbs && fullDayAbsenceDays.has(fmtDate(e.startTs))) continue;
		const h = entryHours(e, isAbs, hoursPerDay, until(e));
		if (isAbs) {
			add(e.activityId, h);
			continue;
		}
		const day = fmtDate(e.startTs);
		let perActivity = workByDay.get(day);
		if (!perActivity) {
			perActivity = new Map();
			workByDay.set(day, perActivity);
		}
		perActivity.set(e.activityId, (perActivity.get(e.activityId) ?? 0) + h);
	}

	let breakHours = 0;
	for (const perActivity of workByDay.values()) {
		let brutto = 0;
		for (const h of perActivity.values()) brutto += h;
		const netto = deductBreaks ? deductBreakFromDay(perActivity) : perActivity;
		let sum = 0;
		for (const [id, h] of netto) {
			add(id, h);
			sum += h;
		}
		breakHours += brutto - sum;
	}

	// Aktive Aktivitäten immer; archivierte nur, wenn sie in diesem Monat Stunden haben
	// (so bleiben erfasste Stunden IMMER im Bericht – Archivieren verliert nichts).
	const ordered = activities
		.filter((a) => !a.archived || (hoursByActivity.get(a.id) ?? 0) > 0)
		.sort((a, b) => a.sortOrder - b.sortOrder);

	const rows: ReportRow[] = ordered.map((a) => {
		const raw = hoursByActivity.get(a.id) ?? 0;
		// Abwesenheiten sind bereits in Tagesschritten "sauber" -> nicht runden.
		return {
			activityId: a.id,
			name: a.name,
			hours: a.isAbsence ? raw : roundHours(raw, step),
			isAbsence: a.isAbsence
		};
	});

	const absenceHours = rows.filter((r) => r.isAbsence).reduce((s, r) => s + r.hours, 0);
	const workHours = rows.filter((r) => !r.isAbsence).reduce((s, r) => s + r.hours, 0);

	return {
		month,
		label: monthLabel(month),
		rows,
		total: workHours + absenceHours,
		absenceHours,
		workHours,
		breakHours
	};
}

/**
 * Baut die HTML-Tabelle im Layout des Screenshots (Outlook-tauglich, inline-Styles).
 * Dient zugleich als Vorschau in der App und als E-Mail-Body.
 */
export function reportToHtml(report: MonthReport): string {
	const cell = "border:1px solid #7f7f7f;padding:4px 10px;font-size:11pt;";
	const gray = "background:#d9d9d9;";
	const head =
		"border:1px solid #7f7f7f;padding:6px 10px;font-size:11pt;text-align:center;font-weight:normal;background:#f2f2f2;";

	const rowsHtml = report.rows
		.map((r, i) => {
			const bg = i % 2 === 1 ? gray : "";
			const val = r.hours > 0 ? fmtHoursClock(r.hours) : "";
			return `<tr>
  <td style="${cell}${bg}">${escapeHtml(r.name)}</td>
  <td style="${cell}${bg}text-align:right;">${val}</td>
</tr>`;
		})
		.join("\n");

	return `<table style="border-collapse:collapse;font-family:Calibri,Arial,sans-serif;width:520px;">
<tr>
  <td style="${head}">Activities<br>Automation Engineering</td>
  <td style="${head}width:80px;">Stunden</td>
</tr>
${rowsHtml}
<tr>
  <td style="${cell}font-weight:bold;">Summe</td>
  <td style="${cell}font-weight:bold;text-align:right;">${fmtHoursClock(report.total)}</td>
</tr>
</table>
<p style="font-family:Calibri,Arial,sans-serif;font-size:10pt;color:#555;">
Arbeitszeit: ${fmtHoursClock(report.workHours)} h&nbsp;&nbsp;|&nbsp;&nbsp;Abwesenheiten: ${fmtHoursClock(report.absenceHours)} h&nbsp;&nbsp;|&nbsp;&nbsp;Gesamt: ${fmtHoursClock(report.total)} h
</p>`;
}

/**
 * Reine Textfassung des Berichts – als Body fuer den mailto-Fallback,
 * wenn kein klassisches Outlook fuer die HTML-Tabelle verfuegbar ist.
 */
export function reportToText(report: MonthReport): string {
	const lines = report.rows
		.filter((r) => r.hours > 0)
		.map((r) => `${r.name}: ${fmtHoursClock(r.hours)} h`);
	lines.push(
		"",
		`Arbeitszeit: ${fmtHoursClock(report.workHours)} h`,
		`Abwesenheiten: ${fmtHoursClock(report.absenceHours)} h`,
		`Gesamt: ${fmtHoursClock(report.total)} h`
	);
	return lines.join("\n");
}

function escapeHtml(s: string): string {
	return s
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

/**
 * Erinnerungs-Datum für den Monat von `d`: letzter Werktag, optional `lead`
 * Werktage davor, auf `time` (HH:MM) gesetzt.
 */
export function reportReminderDate(d: Date, time: string, lead: number): Date {
	// Nicht `h || 16`: Stunde 0 ist falsy, eine Erinnerung um 00:30 feuerte um 16:30.
	const [rawH, rawM] = time.split(":").map(Number);
	const h = Number.isFinite(rawH) ? rawH : 16;
	const m = Number.isFinite(rawM) ? rawM : 0;
	// Der Werktags-Rueckwaertslauf ist Kalenderarbeit und laeuft deshalb auf
	// "YYYY-MM-DD" in der Zeitzone des Kontos. Erst ganz am Ende wird daraus ein
	// Zeitpunkt – mit der Wanduhrzeit dieser Zone, nicht der des Geraets.
	const p = zonedParts(d.getTime());
	let day = isoDate(p.year, p.month, daysInMonth(p.year, p.month)); // letzter Tag des Monats
	const stepBackToWeekday = () => {
		while (weekdayOfDate(day) === 0 || weekdayOfDate(day) === 6) {
			day = addCalendarDays(day, -1);
		}
	};
	stepBackToWeekday();
	// `lead` weitere Werktage zurückgehen.
	for (let i = 0; i < Math.max(0, lead); i++) {
		day = addCalendarDays(day, -1);
		stepBackToWeekday();
	}
	return new Date(wallToTs(...isoParts(day), h, m, 0));
}

/** "YYYY-MM-DD" -> [Jahr, Monat, Tag] fuer `wallToTs`. */
function isoParts(date: string): [number, number, number] {
	const [y, m, d] = date.split("-").map(Number);
	return [y, m, d];
}

