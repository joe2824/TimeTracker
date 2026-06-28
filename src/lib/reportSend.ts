import { app } from "./app.svelte";
import { buildReport, reportToHtml } from "./report";
import { createOutlookDraft } from "./outlook";

/** Betreff aus Vorlage ({month}, {name}) bauen und Trenner aufräumen. */
export function reportSubject(label: string): string {
	return (app.settings.reportSubjectTemplate || "Stundenerfassung {month} – {name}")
		.replaceAll("{month}", label)
		.replaceAll("{name}", app.settings.senderName.trim())
		.replace(/\s*[–-]\s*$/, "")
		.replace(/^\s*[–-]\s*/, "")
		.replace(/\s{2,}/g, " ")
		.trim();
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
		app.settings.hoursPerDay
	);
	const html = reportToHtml(report);
	await createOutlookDraft(app.settings.bossEmail, reportSubject(report.label), html);
	await app.markReportSent(month);
}
