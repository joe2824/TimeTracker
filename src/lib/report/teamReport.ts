// Chef-Modus: Abgabe-Kontrolle der Monatsberichte des Teams.
import type { TeamMember } from "../types";
import { fmtClock, fmtDate, monthKey, monthLabel, prevMonthKey } from "../time/time";
import { isoDate, zonedParts } from "../time/tz";

// ---------- Monat und Name aus dem Betreff ----------

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
 */
export function nameFromSubject(subject: string, subjectFilter = ""): string | null {
	const parts = subject.split(/\s[–—-]\s/);
	if (parts.length >= 2) {
		const last = parts[parts.length - 1].trim();
		// Kein Name, wenn dort der Monat steht ("… – Juli 2026").
		if (last && !monthFromSubject(last)) return last;
	}

	// Ohne Trennstrich: alles wegstreichen, was bekannt ist – das Betreff-Merkmal
	// und die Monatsangabe. Was uebrig bleibt, ist der Name. Deckt die Form ab,
	// die in der Praxis vorkommt: "Anna Meier Stundenerfassung Juli 2026".
	if (!subjectFilter.trim()) return null;
	const rest = stripKnown(subject, subjectFilter)
		.replace(/[–—\-,;:]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	return rest && !/^\d+$/.test(rest) ? rest : null;
}

/** Betreff ohne Betreff-Merkmal und ohne Monatsangabe. */
function stripKnown(subject: string, subjectFilter: string): string {
	let s = subject;
	const filter = subjectFilter.trim();
	if (filter) s = s.replace(new RegExp(escapeRegExp(filter), "gi"), " ");
	return s
		.replace(new RegExp(`\\b(${MONTHS_DE.join("|")})\\s+\\d{4}\\b`, "gi"), " ")
		.replace(/\b\d{4}-(0[1-9]|1[0-2])\b/g, " ");
}

function escapeRegExp(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Das Teammitglied, dessen Name im Betreff steht – egal an welcher Stelle. */
function memberFromSubject(
	subject: string,
	team: TeamMember[],
	subjectFilter: string
): TeamMember | undefined {
	const words = new Set(tokens(stripKnown(subject, subjectFilter)));
	let best: TeamMember | undefined;
	let bestLen = 0;
	for (const m of team) {
		const parts = tokens(m.name);
		if (parts.length === 0 || !parts.every((p) => words.has(p))) continue;
		// Laengster Treffer gewinnt: steht "Anna" und "Anna Meier" im Team, ist
		// "Anna Meier" der genauere.
		const len = parts.join("").length;
		if (len > bestLen) {
			best = m;
			bestLen = len;
		}
	}
	return best;
}

/** Woerter ab zwei Zeichen, kleingeschrieben. Bindestrich trennt (Meier-Schmidt). */
function tokens(s: string): string[] {
	return s
		.toLowerCase()
		.split(/[^\p{L}\p{N}]+/u)
		.filter((t) => t.length >= 2);
}

/**
 * Ersatzweise der Monat aus dem Empfangsdatum: bis zum 10. gilt die Mail dem
 * VORmonat, danach dem laufenden.
 */
export function monthFromReceived(ts: number): string {
	return zonedParts(ts).day > 10 ? monthKey(ts) : prevMonthKey(ts);
}

/**
 * Zeitraum, in dem Mails zu einem Berichtsmonat gesucht werden: vom Monatsersten
 * bis zum 20. des Folgemonats. Frueh genug fuer den, der schon am 20. meldet,
 * spaet genug fuer den Nachzuegler.
 */
export function scanRange(month: string): { start: string; end: string } {
	const [y, m] = month.split("-").map(Number);
	// Der 20. des FOLGEmonats – reine Kalenderrechnung, damit der Jahreswechsel
	// (Dezember -> Januar) ohne lokale Date-Konstruktion stimmt.
	const year = m === 12 ? y + 1 : y;
	const month2 = m === 12 ? 1 : m + 1;
	return { start: `${month}-01`, end: isoDate(year, month2, 20) };
}

// ---------- Zusammenfassung ----------

/** Eine eingegangene Berichts-Mail, einer Person zugeordnet. */
export interface TeamEntry {
	/**
	 * Eindeutig innerhalb einer Uebersicht – auch fuer Mails ohne erkennbaren
	 * Absender. Die Oberflaeche braucht das als Listenschluessel.
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
}

export interface TeamSummary {
	month: string;
	label: string;
	/** Eingegangene Berichte, nach Namen sortiert */
	entries: TeamEntry[];
	/** Teammitglieder ohne Bericht in diesem Monat */
	missing: TeamMember[];
}

interface RawMail {
	subject: string;
	senderName: string;
	senderEmail: string;
	/** ISO-Zeitstempel */
	received: string;
}

const norm = (s: string) => s.trim().toLowerCase();

/**
 * Baut aus den gelesenen Mails die Abgabe-Uebersicht eines Monats.
 *
 * Absender ausserhalb der Teamliste werden NICHT verworfen, sondern mit
 * `memberId = null` gefuehrt - beim ersten Einrichten ist die Liste leer.
 */
export function buildTeamSummary(
	month: string,
	mails: RawMail[],
	team: TeamMember[],
	/** Das Betreff-Merkmal aus den Einstellungen – hilft, den Namen freizulegen. */
	subjectFilter = ""
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

		// Wege zur Person: Adresse, dann Absendername. Der Betreff zaehlt NUR, wenn
		// Outlook ueberhaupt keinen Absender herausgegeben hat (siehe
		// nameFromSubject) – sonst gewaenne bei einer weitergeleiteten Mail der Name
		// im Betreff ueber den tatsaechlichen Absender.
		const subjectName = nameFromSubject(mail.subject, subjectFilter);
		const anonymous = !mail.senderEmail.trim() && !mail.senderName.trim();
		const member =
			byEmail.get(norm(mail.senderEmail)) ??
			byName.get(norm(mail.senderName)) ??
			(anonymous ? memberFromSubject(mail.subject, team, subjectFilter) : undefined);

		const email = member?.email || mail.senderEmail;

		// Schluessel bewusst ueber die Person, nicht die Mail: zwei Mails derselben
		// Person zum selben Monat sind eine Korrektur, keine zwei Berichte.
		const key =
			member?.id ||
			norm(email) ||
			norm(mail.senderName) ||
			norm(subjectName ?? "") ||
			`mail:${receivedTs}:${norm(mail.subject)}`;

		const entry: TeamEntry = {
			key,
			memberId: member?.id ?? null,
			name: member?.name || mail.senderName || subjectName || mail.senderEmail || "(unbekannt)",
			email,
			receivedTs,
			subject: mail.subject,
			monthSource: fromSubject ? "subject" : "received"
		};

		const prev = newest.get(key);
		if (!prev || entry.receivedTs > prev.receivedTs) newest.set(key, entry);
	}

	const entries = [...newest.values()].sort((a, b) => a.name.localeCompare(b.name, "de"));
	const reported = new Set(entries.map((e) => e.memberId).filter(Boolean));

	return {
		month,
		label: monthLabel(month),
		entries,
		missing: team.filter((m) => !reported.has(m.id))
	};
}

// ---------- Ausgabe ----------

function csvCell(s: string): string {
	// Excel wertet eine Zelle, die mit = + @ beginnt, als FORMEL aus. Die Namen
	// hier stammen aus fremden Mails – ein Absendername wie "=1+1" wuerde in der
	// Tabelle des Chefs ausgefuehrt.
	const safe = /^[=+@\t\r]/.test(s) ? `'${s}` : s;
	return /[";\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/**
 * Die Abgabe-Uebersicht als CSV (Semikolon) – so oeffnet Excel sie hierzulande
 * ohne Import-Assistent. Das BOM setzt die Rust-Seite beim Schreiben.
 */
export function teamSummaryToCsv(summary: TeamSummary): string {
	const head = ["Mitarbeiter", "E-Mail", "Status", "Eingegangen am"];
	const rows = summary.entries.map((e) => [
		e.name,
		e.email,
		"abgegeben",
		`${fmtDate(e.receivedTs)} ${fmtClock(e.receivedTs)}`
	]);
	for (const m of summary.missing) {
		rows.push([m.name, m.email, "kein Bericht", ""]);
	}
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
