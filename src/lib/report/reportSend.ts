import { app } from "../app.svelte";
import { buildReport, buildSubject, reportToHtml, reportToText } from "./report";
import { createOutlookDraft, mailtoFallback } from "./outlook";
import { capabilities } from "../platform/env";
import { openExternal } from "../platform/open";

/** Betreff aus Vorlage und Einstellungen – Regel siehe report.ts. */
export function reportSubject(label: string): string {
	return buildSubject(app.settings.reportSubjectTemplate, label, app.settings.senderName);
}

/**
 * "rich" = die gerenderte Tabelle liegt bereit, "source" = nur der Quelltext,
 * null = die Zwischenablage war gar nicht erreichbar.
 */
export type ClipboardMode = "rich" | "source" | null;

/**
 * Legt die Tabelle als "text/html" UND "text/plain" in die Zwischenablage.
 * Nur mit dem text/html-Flavor fuegt ein Mailprogramm die gerenderte Tabelle
 * ein – writeText() allein landet als Quelltext in der Mail.
 */
export async function copyReportToClipboard(html: string, text: string): Promise<ClipboardMode> {
	try {
		await navigator.clipboard.write([
			new ClipboardItem({
				"text/html": new Blob([html], { type: "text/html" }),
				"text/plain": new Blob([text], { type: "text/plain" })
			})
		]);
		return "rich";
	} catch {
		// Aeltere Webviews ohne ClipboardItem/write: Quelltext ist besser als nichts.
		try {
			await navigator.clipboard.writeText(html);
			return "source";
		} catch {
			return null;
		}
	}
}

/**
 * Steht als einzige Zeile im Entwurf, solange die Tabelle noch nicht eingefuegt
 * ist. Im Mailfenster steht der Hinweis vor Augen - ein Toast liegt da hinter
 * dem Mailprogramm.
 */
export const PASTE_HINT =
	"Die Tabelle liegt in der Zwischenablage. Bitte hier mit Strg+V einfügen und diese Zeile löschen.";

/**
 * Weg ohne Outlook: mailto kann nur reinen Text, eine Tabelle passt da nicht
 * hinein. Also erst die Tabelle in die Zwischenablage, dann das Mailfenster mit
 * dem Hinweis oeffnen – eingefuegt wird von Hand. Nur wenn die Zwischenablage
 * versagt, kommt der Text ersatzweise in die Mail.
 *
 * Wirft, wenn sich das Mailprogramm nicht oeffnen laesst.
 */
export async function openMailWithReport(
	to: string,
	subject: string,
	html: string,
	text: string
): Promise<ClipboardMode> {
	const mode = await copyReportToClipboard(html, text);
	await openExternal(mailtoFallback(to, subject, mode === "rich" ? PASTE_HINT : text));
	return mode;
}

/** Wie der Bericht auf den Weg gebracht wurde. */
export type SendResult = { via: "outlook" } | { via: "mail"; clipboard: ClipboardMode };

/**
 * Bringt den Monatsbericht auf den Weg und markiert ihn als erledigt: per
 * Outlook-Entwurf, wo es Outlook gibt, sonst ueber das Mailprogramm des
 * Systems. Wirft, wenn beides fehlschlaegt (Aufrufer zeigt Toast).
 */
export async function sendReport(month: string): Promise<SendResult> {
	await app.ensureMonth(month);
	const report = buildReport(
		month,
		app.activities,
		app.monthEntries(month),
		app.settings.rounding,
		app.settings.hoursPerDay,
		app.settings.workdays,
		Date.now(),
		app.settings.breakDeduction
	);
	const html = reportToHtml(report);
	const subject = reportSubject(report.label);

	let result: SendResult;
	if (capabilities.outlook) {
		await createOutlookDraft(app.settings.bossEmail, subject, html);
		result = { via: "outlook" };
	} else {
		const clipboard = await openMailWithReport(
			app.settings.bossEmail,
			subject,
			html,
			reportToText(report)
		);
		result = { via: "mail", clipboard };
	}
	await app.markReportSent(month);
	return result;
}
