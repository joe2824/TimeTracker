import { app } from "./app.svelte";
import { buildReport, reportSubject as buildSubject, reportToHtml } from "./report";
import { createOutlookDraft } from "./outlook";

/** Betreff aus Vorlage und Einstellungen – Regel siehe report.ts. */
export function reportSubject(label: string): string {
	return buildSubject(app.settings.reportSubjectTemplate, label, app.settings.senderName);
}

/**
 * Erstellt für einen Monat den Outlook-Entwurf und markiert ihn als erledigt.
 * Wirft bei Outlook-Fehler (Aufrufer zeigt Toast).
 */
export async function sendReport(month: string): Promise<void> {
	await app.ensureMonth(month);
	const report = buildReport(
		month,
		app.activities,
		app.monthEntries(month),
		app.settings.rounding,
		app.settings.hoursPerDay,
		app.settings.workdays
	);
	const html = reportToHtml(report);
	await createOutlookDraft(app.settings.bossEmail, reportSubject(report.label), html);
	await app.markReportSent(month);
}
