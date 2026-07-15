import type { Activity, Entry } from "./types";
import { entryHours, fmtDate, fmtHoursClock, isWorkday, monthLabel, roundHours } from "./time";

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
}

/**
 * Aggregiert die Eintraege eines Monats zu einer Zeile je Aktivitaet.
 * Es erscheinen ALLE nicht-archivierten Aktivitaeten (auch mit 0 Stunden),
 * jeweils auf `step` Stunden gerundet.
 */
export function buildReport(
	month: string,
	activities: Activity[],
	entries: Entry[],
	step: number,
	hoursPerDay: number,
	workdays?: number[]
): MonthReport {
	const absenceIds = new Set(activities.filter((a) => a.isAbsence).map((a) => a.id));

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
	for (const e of entries) {
		const isAbs = absenceIds.has(e.activityId);
		// Abwesenheit an einem Nicht-Arbeitstag komplett ignorieren.
		if (isAbs && workdays && !isWorkday(e.startTs, workdays)) continue;
		// Projekteintraege an Ganztags-Abwesenheitstagen ignorieren.
		if (!isAbs && fullDayAbsenceDays.has(fmtDate(e.startTs))) continue;
		const h = entryHours(e, isAbs, hoursPerDay);
		hoursByActivity.set(e.activityId, (hoursByActivity.get(e.activityId) ?? 0) + h);
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
		workHours
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
  <td style="${head}">Acitivities<br>Automation Engineering</td>
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
