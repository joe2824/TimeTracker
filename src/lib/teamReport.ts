// Chef-Modus: aus den eingegangenen Berichts-Mails des Teams eine Zusammenfassung
// bauen.
//
// Gelesen wird ausschliesslich, was TimeTracker selbst verschickt hat (die
// HTML-Tabelle aus report.ts, ersatzweise deren Textfassung). Fremde Formate
// werden NICHT geraten: eine falsch gelesene Stundenzahl faellt niemandem auf und
// steht am Ende in der Auswertung des ganzen Teams. Was nicht sicher lesbar ist,
// erscheint als "nicht lesbar" – sichtbar statt still verkehrt.
import type { TeamMember } from "./types";
import { fmtHoursClock, monthLabel } from "./time";

/** Eine Zeile aus dem Bericht einer Person: Aktivitaet + Stunden. */
export interface ReportLine {
	name: string;
	hours: number;
}

/** Das aus einer Mail gelesene Ergebnis. */
export interface ParsedReport {
	lines: ReportLine[];
	/** Summenzeile der Mail, falls vorhanden – sonst null (dann selbst summieren). */
	total: number | null;
}

// ---------- HTML-Werkzeug ----------

const ENTITIES: Record<string, string> = {
	amp: "&",
	lt: "<",
	gt: ">",
	quot: '"',
	apos: "'",
	nbsp: " ",
	ndash: "–",
	mdash: "—"
};

function decodeEntities(s: string): string {
	return s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (all, code: string) => {
		if (code[0] === "#") {
			const num =
				code[1] === "x" || code[1] === "X"
					? parseInt(code.slice(2), 16)
					: parseInt(code.slice(1), 10);
			return Number.isFinite(num) ? String.fromCodePoint(num) : all;
		}
		return ENTITIES[code.toLowerCase()] ?? all;
	});
}

/** Tags entfernen und Leerraum zusammenziehen – der sichtbare Text einer Zelle. */
function cellText(html: string): string {
	return decodeEntities(html.replace(/<[^>]*>/g, " "))
		.replace(/\s+/g, " ")
		.trim();
}

/**
 * HTML zu Text, mit Zeilenumbruechen an den Stellen, an denen auch im Mailfenster
 * eine neue Zeile beginnt. Fuer den Textfassungs-Ersatzweg (siehe parseReportBody).
 */
function htmlToText(html: string): string {
	return decodeEntities(
		html
			.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "")
			.replace(/<br\s*\/?>/gi, "\n")
			.replace(/<\/(p|div|tr|li|h[1-6])\s*>/gi, "\n")
			.replace(/<[^>]*>/g, "")
	)
		.replace(/[ \t ]+/g, " ")
		.replace(/\r\n?/g, "\n");
}

/**
 * Die <tr>-Bloecke je Tabelle, verschachtelte Tabellen getrennt.
 *
 * Outlook baut die Mail beim Antworten um und verpackt Inhalte gern in eigene
 * Layout-Tabellen. Ohne diese Trennung landeten deren Zellen in derselben Liste
 * wie die Berichtszeilen.
 */
function tableRows(html: string): string[][] {
	const token = /<table\b[^>]*>|<\/table\s*>|<tr\b[^>]*>([\s\S]*?)<\/tr\s*>/gi;
	const tables: string[][] = [];
	const open: string[][] = [];
	for (let m = token.exec(html); m; m = token.exec(html)) {
		const tag = m[0].slice(0, 7).toLowerCase();
		if (tag.startsWith("<table")) {
			open.push([]);
		} else if (tag.startsWith("</tabl")) {
			const done = open.pop();
			if (done) tables.push(done);
		} else if (open.length > 0) {
			// Die Zeile gehoert zur innersten offenen Tabelle.
			open[open.length - 1].push(m[1]);
		}
	}
	// Nicht geschlossene Tabellen trotzdem mitnehmen: bei gekapptem Body (200k
	// Zeichen) fehlt das schliessende Tag, die Zeilen davor sind aber gueltig.
	for (const rest of open) tables.push(rest);
	return tables;
}

function rowCells(rowHtml: string): string[] {
	const out: string[] = [];
	const cell = /<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]\s*>/gi;
	for (let m = cell.exec(rowHtml); m; m = cell.exec(rowHtml)) out.push(cellText(m[1]));
	return out;
}

// ---------- Zahlen ----------

/** Zeilen, die eine Summe tragen statt einer Aktivitaet. */
const TOTAL_RE = /^(summe|gesamt|total|gesamtsumme)\b/i;

/** Zusammenfassungszeilen der Textfassung, die keine Aktivitaet sind. */
const TEXT_SUMMARY_RE = /^(arbeitszeit|abwesenheiten|gesamt)\s*:/i;

/**
 * Stundenwert einer Zelle. Akzeptiert das Format des Berichts ("7:30") und
 * Dezimalzahlen ("7,5" / "7.5"), jeweils mit optionalem "h".
 *
 * Null bei allem anderen – insbesondere bei Text ("Stunden", "Summe") und bei
 * leeren Zellen. Genau daran werden Kopf- und Leerzeilen erkannt: der Bericht
 * laesst die Zelle bei 0 Stunden leer.
 */
export function parseHoursCell(raw: string): number | null {
	const t = raw
		.trim()
		.replace(/\s*(h|std\.?|stunden)$/i, "")
		.trim();
	if (!t) return null;
	const clock = /^(-?)(\d{1,4}):([0-5]\d)$/.exec(t);
	if (clock) {
		const value = Number(clock[2]) + Number(clock[3]) / 60;
		return plausible(clock[1] ? -value : value);
	}
	if (!/^-?\d{1,6}([.,]\d{1,4})?$/.test(t)) return null;
	const n = Number(t.replace(",", "."));
	return Number.isFinite(n) ? plausible(n) : null;
}

/** Ein Monat hat hoechstens 31 * 24 Stunden. */
const MAX_HOURS = 744;

/**
 * Blanke Zahlen sind nicht zwangslaeufig Stunden: in einer Signatur stehen
 * Telefonnummern, in einer Bestellbestaetigung Auftragsnummern, im Text
 * Jahreszahlen. Was als Monatsstunden nicht sein KANN, ist auch keine.
 */
function plausible(h: number): number | null {
	return Math.abs(h) <= MAX_HOURS ? h : null;
}

// ---------- Mail lesen ----------

function rowsToReport(rows: string[]): ParsedReport | null {
	const lines: ReportLine[] = [];
	let total: number | null = null;
	for (const row of rows) {
		const cells = rowCells(row);
		if (cells.length < 2) continue;
		const label = cells[0];
		const value = parseHoursCell(cells[cells.length - 1]);
		if (!label || value === null) continue;
		if (TOTAL_RE.test(label)) {
			total ??= value;
			continue;
		}
		lines.push({ name: label, hours: value });
	}
	return lines.length > 0 ? { lines, total } : null;
}

/**
 * Die Berichtstabelle aus dem HTML-Body – die beste, wenn mehrere in Frage
 * kommen (Antwort-Verlauf, Signatur-Layout).
 *
 * Die Summenzeile ist PFLICHT, nicht nur ein Pluspunkt: der Bericht dieser App
 * hat immer eine, eine beliebige zweispaltige Tabelle nicht. Ohne diese Huerde
 * ging schon eine Signatur mit zwei Telefonnummern als Bericht durch – zwei
 * Zeilen, zwei Zahlen, fertig war die erfundene Stundenmeldung.
 */
function bestTable(html: string): ParsedReport | null {
	let best: ParsedReport | null = null;
	let bestScore = 0;
	for (const rows of tableRows(html)) {
		const parsed = rowsToReport(rows);
		if (!parsed || parsed.total === null) continue;
		if (parsed.lines.length > bestScore) {
			best = parsed;
			bestScore = parsed.lines.length;
		}
	}
	return best;
}

/**
 * Die Textfassung des Berichts (reportToText): erst die Aktivitaetszeilen, dann
 * eine Leerzeile, dann Arbeitszeit/Abwesenheiten/Gesamt.
 *
 * Die Leerzeile ist die Trennung, nicht die Beschriftung: "Abwesenheiten" steht
 * in beiden Bloecken. Ohne diese Grenze zaehlte der Abwesenheitsblock doppelt.
 */
function parseReportText(text: string): ParsedReport | null {
	const lines: ReportLine[] = [];
	let total: number | null = null;
	let inSummary = false;
	for (const raw of text.split("\n")) {
		const line = raw.trim();
		if (!line) {
			if (lines.length > 0) inSummary = true;
			continue;
		}
		const m = /^(.+?):\s*(.+)$/.exec(line);
		if (!m) continue;
		const label = m[1].trim();
		const value = parseHoursCell(m[2]);
		if (value === null) continue;
		if (inSummary) {
			if (/^gesamt$/i.test(label)) total ??= value;
			continue;
		}
		lines.push({ name: label, hours: value });
	}

	// Ohne Leerzeile – manche Clients werfen sie beim Umwandeln weg – haengt der
	// Zusammenfassungsblock hinten an den Zeilen. Nur die letzten drei abschneiden
	// und beim "Arbeitszeit" aufhoeren: "Abwesenheiten" ist mittendrin der Name
	// einer echten Aktivitaet und darf nicht mitgerissen werden.
	if (total === null) {
		for (let i = 0; i < 3 && lines.length > 0; i++) {
			const last = lines[lines.length - 1];
			if (!TEXT_SUMMARY_RE.test(`${last.name}:`)) break;
			lines.pop();
			if (/^gesamt$/i.test(last.name)) total = last.hours;
			if (/^arbeitszeit$/i.test(last.name)) break;
		}
	}
	// Ohne "Gesamt" ist es nicht die Textfassung dieses Berichts, sondern
	// irgendein Text mit einer Zahl hinter einem Doppelpunkt ("Telefon: 4711").
	// Die Zeilen einer solchen Mail als Stunden zu buchen, faellt keinem auf.
	return lines.length > 0 && total !== null ? { lines, total } : null;
}

/**
 * Den Bericht aus einem Mail-Body lesen. Null = keine erkennbare Tabelle
 * (fremdes Format, leere Mail, nur Fliesstext).
 */
export function parseReportBody(body: string): ParsedReport | null {
	return bestTable(body) ?? parseReportText(htmlToText(body));
}

// ---------- Monat bestimmen ----------

const MONTHS_DE = [
	"Januar",
	"Februar",
	"März",
	"April",
	"Mai",
	"Juni",
	"Juli",
	"August",
	"September",
	"Oktober",
	"November",
	"Dezember"
];

/**
 * Der Berichtsmonat aus dem Betreff ("Stundenerfassung Juli 2026 – …" oder
 * "… 2026-07"). Null, wenn kein Monat darin steht.
 */
export function monthFromSubject(subject: string): string | null {
	const iso = /\b(\d{4})-(0[1-9]|1[0-2])\b/.exec(subject);
	if (iso) return `${iso[1]}-${iso[2]}`;
	const named = new RegExp(`\\b(${MONTHS_DE.join("|")})\\s+(\\d{4})\\b`, "i").exec(subject);
	if (!named) return null;
	const idx = MONTHS_DE.findIndex((n) => n.toLowerCase() === named[1].toLowerCase());
	if (idx < 0) return null;
	return `${named[2]}-${String(idx + 1).padStart(2, "0")}`;
}

/**
 * Der Absendername aus dem Betreff – in der Vorlage der Teil hinter dem letzten
 * Gedankenstrich ("Stundenerfassung Juli 2026 – Anna Meier").
 *
 * Klingt nach Beiwerk, ist aber der einzige verlaessliche Weg: Outlook verweigert
 * Name und Adresse des Absenders, sobald die Richtlinie
 * "PromptOOMAddressInformationAccess" auf Nachfragen steht – und nachfragen kann
 * es bei einem Hintergrundzugriff niemanden. Der Betreff ist nie geschuetzt.
 */
export function nameFromSubject(subject: string): string | null {
	const parts = subject.split(/\s[–—-]\s/);
	if (parts.length < 2) return null;
	const last = parts[parts.length - 1].trim();
	// Kein Name, wenn dort der Monat steht ("… – Juli 2026").
	return last && !monthFromSubject(last) ? last : null;
}

/**
 * Ersatzweise der Monat aus dem Empfangsdatum: bis zum 10. gilt die Mail dem
 * VORmonat, danach dem laufenden.
 *
 * Berichte kommen am Monatsende oder in den ersten Tagen danach – die eigene
 * Erinnerung der App feuert am letzten Werktag. Ein Bericht ohne Monat im
 * Betreff ginge ohne diese Annahme gar nicht zuzuordnen.
 */
export function monthFromReceived(ts: number): string {
	const d = new Date(ts);
	if (d.getDate() <= 10) d.setMonth(d.getMonth() - 1, 1);
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

/**
 * Zeitraum, in dem Mails zu einem Berichtsmonat gesucht werden: vom Monatsersten
 * bis zum 20. des Folgemonats. Frueh genug fuer den, der schon am 20. meldet,
 * spaet genug fuer den Nachzuegler.
 */
export function scanRange(month: string): { start: string; end: string } {
	const [y, m] = month.split("-").map(Number);
	const end = new Date(y, m, 20);
	const pad = (n: number) => String(n).padStart(2, "0");
	return {
		start: `${month}-01`,
		end: `${end.getFullYear()}-${pad(end.getMonth() + 1)}-${pad(end.getDate())}`
	};
}

// ---------- Zusammenfassung ----------

/** Der Bericht einer Person, so wie er aus ihrer Mail gelesen wurde. */
export interface TeamEntry {
	/**
	 * Eindeutig innerhalb einer Zusammenfassung – auch fuer Mails ohne
	 * erkennbaren Absender. Die Oberflaeche braucht das als Listenschluessel.
	 */
	key: string;
	/** id des Teameintrags, oder null bei einem Absender ausserhalb des Teams */
	memberId: string | null;
	name: string;
	email: string;
	receivedTs: number;
	subject: string;
	/** Woher der Monat stammt – "received" ist geraten, siehe monthFromReceived */
	monthSource: "subject" | "received";
	lines: ReportLine[];
	/** Summe der Mail, sonst die Summe der Zeilen */
	total: number;
	/** false = keine Tabelle erkannt; die Mail wird nur gemeldet, nicht gewertet */
	parsed: boolean;
	/**
	 * false = Outlook hat zu dieser Mail gar keinen Inhalt herausgegeben (nur
	 * Kopfzeilen geladen). Muss von "Inhalt da, aber fremdes Format" getrennt
	 * bleiben: das eine liegt an Outlook, das andere am Absender.
	 */
	hasBody: boolean;
}

export interface TeamSummary {
	month: string;
	label: string;
	/** Spalten der Matrix: alle vorkommenden Aktivitaeten, Reihenfolge wie gemeldet */
	activities: string[];
	entries: TeamEntry[];
	/** Teammitglieder ohne Bericht in diesem Monat */
	missing: TeamMember[];
	/**
	 * Wie viele der gefundenen Mails ohne Inhalt ankamen. Ist das alle, liegt es
	 * nicht an den Absendern, sondern an Outlook – die Oberflaeche sagt das dann.
	 */
	bodiesMissing: number;
	total: number;
}

interface RawMail {
	subject: string;
	senderName: string;
	senderEmail: string;
	/** ISO-Zeitstempel */
	received: string;
	body: string;
}

const norm = (s: string) => s.trim().toLowerCase();

/**
 * Baut aus den gelesenen Mails die Team-Uebersicht eines Monats.
 *
 * Absender ausserhalb der Teamliste werden NICHT verworfen, sondern mit
 * memberId = null gefuehrt: beim ersten Einrichten ist die Liste leer, und ein
 * Bericht, der still verschwindet, waere schlimmer als eine Zeile zu viel.
 * Gefiltert wird ueber den Betreff, nicht ueber die Teamliste.
 *
 * Mehrere Mails derselben Person zum selben Monat: die neueste gewinnt – eine
 * Korrektur wird nachgeschickt, nicht die alte zurueckgezogen.
 */
export function buildTeamSummary(
	month: string,
	mails: RawMail[],
	team: TeamMember[]
): TeamSummary {
	const byEmail = new Map(team.filter((m) => m.email.trim()).map((m) => [norm(m.email), m]));
	const byName = new Map(team.filter((m) => m.name.trim()).map((m) => [norm(m.name), m]));

	const newest = new Map<string, TeamEntry>();
	for (const mail of mails) {
		const receivedTs = new Date(mail.received).getTime();
		if (!Number.isFinite(receivedTs)) continue;

		const fromSubject = monthFromSubject(mail.subject);
		const mailMonth = fromSubject ?? monthFromReceived(receivedTs);
		if (mailMonth !== month) continue;

		// Wege zur Person: Adresse, dann Absendername. Der Name aus dem Betreff
		// zaehlt NUR, wenn Outlook ueberhaupt keinen Absender herausgegeben hat
		// (siehe nameFromSubject) – sonst gewaenne bei einer weitergeleiteten Mail
		// der Name im Betreff ueber den tatsaechlichen Absender.
		const subjectName = nameFromSubject(mail.subject);
		const anonym = !mail.senderEmail.trim() && !mail.senderName.trim();
		const member =
			byEmail.get(norm(mail.senderEmail)) ??
			byName.get(norm(mail.senderName)) ??
			(anonym && subjectName ? byName.get(norm(subjectName)) : undefined);
		const parsed = parseReportBody(mail.body);
		const lines = parsed?.lines ?? [];
		const email = member?.email || mail.senderEmail;

		// Schluessel bewusst ueber die Person, nicht die Mail: zwei Mails derselben
		// Person zum selben Monat sind eine Korrektur, keine zwei Berichte.
		//
		// Nur: wenn Outlook Absender UND Name verschweigt und auch im Betreff keiner
		// steht, gibt es keine Person, ueber die sich gruppieren liesse. Dann ist
		// jede Mail ihr eigener Eintrag – sonst faellt sie mit jeder anderen
		// namenlosen zu EINER Zeile zusammen, und das Team verliert stillschweigend
		// Berichte. Der Anzeigename taugt dafuer nicht: der ist dann fuer alle
		// "(unbekannt)".
		const key =
			member?.id ||
			norm(email) ||
			norm(mail.senderName) ||
			norm(subjectName ?? "") ||
			`mail:${receivedTs}:${norm(mail.subject)}`;

		const entry: TeamEntry = {
			key,
			memberId: member?.id ?? null,
			name:
				member?.name || mail.senderName || subjectName || mail.senderEmail || "(unbekannt)",
			email,
			receivedTs,
			subject: mail.subject,
			monthSource: fromSubject ? "subject" : "received",
			lines,
			total: parsed?.total ?? lines.reduce((s, l) => s + l.hours, 0),
			parsed: parsed !== null,
			hasBody: mail.body.trim().length > 0
		};

		const prev = newest.get(key);
		if (!prev || entry.receivedTs > prev.receivedTs) newest.set(key, entry);
	}

	const entries = [...newest.values()].sort((a, b) => a.name.localeCompare(b.name, "de"));

	// Spalten in der Reihenfolge, in der sie in den Berichten stehen: das ist die
	// gemeinsame Aktivitaetsliste der Firma, alphabetisch sortiert waere sie eine
	// andere als die, die alle aus ihrem eigenen Bericht kennen.
	const activities: string[] = [];
	const seen = new Set<string>();
	for (const e of entries) {
		for (const l of e.lines) {
			const key = norm(l.name);
			if (key && !seen.has(key)) {
				seen.add(key);
				activities.push(l.name);
			}
		}
	}

	const reported = new Set(entries.map((e) => e.memberId).filter(Boolean));
	const missing = team.filter((m) => !reported.has(m.id));

	return {
		month,
		label: monthLabel(month),
		activities,
		entries,
		missing,
		bodiesMissing: entries.filter((e) => !e.hasBody).length,
		total: entries.reduce((s, e) => s + e.total, 0)
	};
}

/** Stunden einer Person fuer eine Aktivitaet (0, wenn nicht gemeldet). */
export function hoursFor(entry: TeamEntry, activity: string): number {
	const key = norm(activity);
	return entry.lines.filter((l) => norm(l.name) === key).reduce((s, l) => s + l.hours, 0);
}

/** Spaltensumme ueber alle Personen. */
export function activityTotal(summary: TeamSummary, activity: string): number {
	return summary.entries.reduce((s, e) => s + hoursFor(e, activity), 0);
}

// ---------- Ausgabe ----------

function escapeHtml(s: string): string {
	return s
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

/**
 * Die Team-Matrix als Outlook-taugliche HTML-Tabelle (inline-Styles, wie der
 * Monatsbericht selbst). Fehlende Meldungen stehen als eigene Zeile drin – wer
 * die Zusammenfassung liest, soll nicht raten muessen, ob jemand null Stunden
 * hatte oder gar nichts geschickt hat.
 */
export function teamSummaryToHtml(summary: TeamSummary): string {
	const cell = "border:1px solid #7f7f7f;padding:4px 10px;font-size:11pt;";
	const gray = "background:#d9d9d9;";
	const head =
		"border:1px solid #7f7f7f;padding:6px 10px;font-size:11pt;text-align:center;font-weight:normal;background:#f2f2f2;";
	const num = "text-align:right;";

	const headCells = [
		`<td style="${head}">Mitarbeiter<br>${escapeHtml(summary.label)}</td>`,
		...summary.activities.map((a) => `<td style="${head}">${escapeHtml(a)}</td>`),
		`<td style="${head}width:80px;">Summe</td>`
	].join("\n  ");

	const rows = summary.entries
		.map((e, i) => {
			const bg = i % 2 === 1 ? gray : "";
			const cells = summary.activities.map((a) => {
				const h = hoursFor(e, a);
				return `<td style="${cell}${bg}${num}">${h > 0 ? fmtHoursClock(h) : ""}</td>`;
			});
			const note = e.parsed ? "" : e.hasBody ? " (Tabelle nicht lesbar)" : " (Inhalt nicht geladen)";
			return `<tr>
  <td style="${cell}${bg}">${escapeHtml(e.name)}${note}</td>
  ${cells.join("\n  ")}
  <td style="${cell}${bg}${num}font-weight:bold;">${fmtHoursClock(e.total)}</td>
</tr>`;
		})
		.join("\n");

	const missingRows = summary.missing
		.map((m) => {
			const empty = summary.activities.map(() => `<td style="${cell}"></td>`).join("\n  ");
			return `<tr>
  <td style="${cell}color:#a00;">${escapeHtml(m.name)}</td>
  ${empty}
  <td style="${cell}${num}color:#a00;">kein Bericht</td>
</tr>`;
		})
		.join("\n");

	const totalCells = summary.activities
		.map((a) => {
			const h = activityTotal(summary, a);
			return `<td style="${cell}${num}font-weight:bold;">${h > 0 ? fmtHoursClock(h) : ""}</td>`;
		})
		.join("\n  ");

	return `<table style="border-collapse:collapse;font-family:Calibri,Arial,sans-serif;">
<tr>
  ${headCells}
</tr>
${rows}
${missingRows}
<tr>
  <td style="${cell}font-weight:bold;">Summe</td>
  ${totalCells}
  <td style="${cell}${num}font-weight:bold;">${fmtHoursClock(summary.total)}</td>
</tr>
</table>
<p style="font-family:Calibri,Arial,sans-serif;font-size:10pt;color:#555;">
${summary.entries.length} Bericht${summary.entries.length === 1 ? "" : "e"}${
		summary.missing.length > 0 ? `&nbsp;&nbsp;|&nbsp;&nbsp;${summary.missing.length} ausstehend` : ""
	}&nbsp;&nbsp;|&nbsp;&nbsp;Gesamt: ${fmtHoursClock(summary.total)} h
</p>`;
}

/** Zahl fuer die CSV: deutsche Dezimalschreibweise, wie Excel sie erwartet. */
function csvHours(h: number): string {
	return h === 0 ? "" : h.toFixed(2).replace(".", ",");
}

function csvCell(s: string): string {
	// Excel wertet eine Zelle, die mit = + @ beginnt, als FORMEL aus. Die Namen
	// hier stammen aus fremden Mails – ein Absendername wie "=1+1" wuerde in der
	// Tabelle des Chefs ausgefuehrt. Fuehrendes "-" bleibt zugelassen, sonst
	// verloeren negative Stunden ihren Zahlencharakter.
	const safe = /^[=+@\t\r]/.test(s) ? `'${s}` : s;
	return /[";\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/**
 * Die Matrix als CSV (Semikolon, deutsche Dezimalzahlen) – so oeffnet Excel sie
 * hierzulande ohne Import-Assistent. Das BOM setzt die Rust-Seite beim Schreiben.
 */
export function teamSummaryToCsv(summary: TeamSummary): string {
	const head = ["Mitarbeiter", "E-Mail", "Status", ...summary.activities, "Summe"];
	const rows = summary.entries.map((e) => [
		e.name,
		e.email,
		e.parsed ? "gemeldet" : e.hasBody ? "nicht lesbar" : "Inhalt nicht geladen",
		...summary.activities.map((a) => csvHours(hoursFor(e, a))),
		csvHours(e.total)
	]);
	for (const m of summary.missing) {
		rows.push([m.name, m.email, "kein Bericht", ...summary.activities.map(() => ""), ""]);
	}
	rows.push([
		"Summe",
		"",
		"",
		...summary.activities.map((a) => csvHours(activityTotal(summary, a))),
		csvHours(summary.total)
	]);
	return [head, ...rows].map((r) => r.map((c) => csvCell(String(c))).join(";")).join("\r\n");
}

/** Betreff der Zusammenfassung an die naechste Ebene. */
export function teamSummarySubject(label: string): string {
	return `Stundenerfassung Team – ${label}`;
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
	return `<p style="font-family:Calibri,Arial,sans-serif;font-size:11pt;">
Hallo,<br><br>
für ${escapeHtml(label)} liegt mir deine Stundenerfassung noch nicht vor.
Bitte schick sie mir bei Gelegenheit nach.<br><br>
Danke!
</p>`;
}
