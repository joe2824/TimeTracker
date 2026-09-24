// Chef-Modus: Ausgabe-Helfer für die Abgabe-Übersicht (CSV, Erinnerungstext).
//
// Wer wann gesendet hat, kommt vom Server (account.listTeamReports) - hier
// wird daraus eine CSV-Datei und ein Erinnerungstext.
import type { TeamReportStatus } from "../sync/api";
import { fmtClock, fmtDate } from "../time/time";

function csvCell(s: string): string {
	// Excel wertet eine Zelle, die mit = + - @ beginnt, als FORMEL aus. Namen
	// stammen von Team-Mitgliedern - ein Name wie "=1+1" würde in der Tabelle
	// des Chefs ausgeführt.
	const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
	return /[";\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/**
 * Die Abgabe-Übersicht eines Monats als CSV (Semikolon) – so öffnet Excel sie
 * hierzulande ohne Import-Assistent. Das BOM setzt die Rust-Seite beim Schreiben.
 */
export function teamReportsToCsv(reports: TeamReportStatus[]): string {
	const head = ["Mitarbeiter", "E-Mail", "Status", "Eingegangen am"];
	const rows = reports.map((r) => [
		r.memberName,
		r.memberEmail ?? "",
		r.submittedAt ? "abgegeben" : "kein Bericht",
		r.submittedAt ? `${fmtDate(r.submittedAt)} ${fmtClock(r.submittedAt)}` : ""
	]);
	return [head, ...rows].map((r) => r.map((c) => csvCell(String(c))).join(";")).join("\r\n");
}

/** Betreff der Erinnerung an die, deren Bericht fehlt. */
export function teamReminderSubject(label: string): string {
	return `Stundenerfassung ${label} – Erinnerung`;
}

/**
 * Text der Erinnerung. Bewusst kurz und ohne Namensliste im Text: die Mail geht
 * an alle Fehlenden zugleich, niemand soll darin lesen, wer sonst noch saeumig ist.
 */
export function teamReminderHtml(label: string): string {
	const safe = label.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
	return `<p style="font-family:Calibri,Arial,sans-serif;font-size:11pt;">
Hallo,<br><br>
für ${safe} liegt mir deine Stundenerfassung noch nicht vor.
Bitte schick sie mir bei Gelegenheit nach.<br><br>
Danke!
</p>`;
}
