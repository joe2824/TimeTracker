import { describe, expect, it } from "vitest";
import { buildReport, reportToHtml, reportToText, reportSubject } from "./report";
import {
	activityTotal,
	buildTeamSummary,
	hoursFor,
	monthFromReceived,
	monthFromSubject,
	nameFromSubject,
	parseHoursCell,
	parseReportBody,
	scanRange,
	teamSummaryToCsv,
	teamSummaryToHtml
} from "./teamReport";
import type { Activity, Entry, TeamMember } from "./types";

// ---- Testdaten: ein echter Bericht, gebaut wie in der App ----

const activities: Activity[] = [
	{ id: "a1", name: "Projekt Alpha", sortOrder: 0, archived: false, isAbsence: false },
	{ id: "a2", name: "Projekt Beta", sortOrder: 1, archived: false, isAbsence: false },
	{ id: "a3", name: "Others", sortOrder: 2, archived: false, isAbsence: false },
	{ id: "a4", name: "Abwesenheiten", sortOrder: 3, archived: false, isAbsence: true }
];

/** Ein abgeschlossener Eintrag am 2026-07-`day` ueber `hours` Stunden. */
function entry(id: string, activityId: string, day: number, hours: number): Entry {
	const start = new Date(2026, 6, day, 8, 0, 0).getTime();
	return {
		id,
		activityId,
		startTs: start,
		endTs: start + hours * 3600_000,
		note: "",
		source: "timer"
	};
}

const entries: Entry[] = [
	entry("e1", "a1", 6, 8),
	entry("e2", "a2", 7, 4),
	entry("e3", "a1", 8, 2.5),
	{
		id: "e4",
		activityId: "a4",
		startTs: new Date(2026, 6, 9, 12, 0, 0).getTime(),
		endTs: new Date(2026, 6, 9, 12, 0, 0).getTime(),
		note: "",
		source: "manual",
		dayFraction: 1
	}
];

const report = buildReport("2026-07", activities, entries, 0.5, 7.5, [1, 2, 3, 4, 5]);
const reportHtml = reportToHtml(report);

const team: TeamMember[] = [
	{ id: "m1", name: "Anna Meier", email: "anna.meier@firma.de" },
	{ id: "m2", name: "Bert Klein", email: "Bert.Klein@firma.de" },
	{ id: "m3", name: "Clara Nowak", email: "clara@firma.de" }
];

function mail(over: Partial<Parameters<typeof buildTeamSummary>[1][number]> = {}) {
	return {
		subject: "Stundenerfassung Juli 2026 – Anna Meier",
		senderName: "Anna Meier",
		senderEmail: "anna.meier@firma.de",
		received: new Date(2026, 7, 1, 9, 30).toISOString(),
		body: reportHtml,
		...over
	};
}

// ---- Zahlen ----

describe("parseHoursCell", () => {
	it("liest das Berichtsformat H:MM", () => {
		expect(parseHoursCell("7:30")).toBe(7.5);
		expect(parseHoursCell("107:15")).toBe(107.25);
		expect(parseHoursCell("0:00")).toBe(0);
	});

	it("liest Dezimalzahlen mit Komma und Punkt, auch mit Einheit", () => {
		expect(parseHoursCell("7,5")).toBe(7.5);
		expect(parseHoursCell("7.5")).toBe(7.5);
		expect(parseHoursCell(" 12 h ")).toBe(12);
	});

	it("weist Text und leere Zellen zurueck – daran haengt die Kopfzeilen-Erkennung", () => {
		expect(parseHoursCell("")).toBeNull();
		expect(parseHoursCell("Stunden")).toBeNull();
		expect(parseHoursCell("Summe")).toBeNull();
		expect(parseHoursCell("Projekt 7")).toBeNull();
	});
});

// ---- Mail lesen ----

describe("parseReportBody", () => {
	it("liest die Tabelle, die die App selbst verschickt", () => {
		const parsed = parseReportBody(reportHtml);
		expect(parsed).not.toBeNull();
		expect(parsed!.lines).toEqual([
			{ name: "Projekt Alpha", hours: 10.5 },
			{ name: "Projekt Beta", hours: 4 },
			{ name: "Abwesenheiten", hours: 7.5 }
		]);
		expect(parsed!.total).toBe(report.total);
	});

	it("laesst 0-Stunden-Zeilen weg (leere Zelle)", () => {
		// "Others" hat keine Stunden und steht deshalb mit leerer Zelle im HTML.
		expect(reportHtml).toContain("Others");
		expect(parseReportBody(reportHtml)!.lines.some((l) => l.name === "Others")).toBe(false);
	});

	it("uebersteht Outlooks Umbau beim Antworten (fremde Attribute, Layout-Tabelle drumherum)", () => {
		const mangled = `<div><table class="MsoNormalTable" border="0"><tr><td>
			<p class=MsoNormal>Von: Anna Meier<o:p></o:p></p>
			${reportHtml.replace(/<td style="/g, '<td class="x" lang=DE style="')}
			</td></tr></table></div>`;
		const parsed = parseReportBody(mangled);
		expect(parsed!.lines).toHaveLength(3);
		expect(parsed!.total).toBe(report.total);
	});

	it("nimmt bei mehreren Tabellen die mit Summenzeile", () => {
		const signature = `<table><tr><td>Telefon</td><td>4711</td></tr><tr><td>Raum</td><td>3</td></tr></table>`;
		const parsed = parseReportBody(signature + reportHtml);
		expect(parsed!.total).toBe(report.total);
		expect(parsed!.lines.map((l) => l.name)).not.toContain("Telefon");
	});

	it("liest ersatzweise die Textfassung (mailto-Fallback)", () => {
		const parsed = parseReportBody(`<pre>${reportToText(report)}</pre>`);
		expect(parsed!.lines).toEqual([
			{ name: "Projekt Alpha", hours: 10.5 },
			{ name: "Projekt Beta", hours: 4 },
			{ name: "Abwesenheiten", hours: 7.5 }
		]);
		expect(parsed!.total).toBe(report.total);
	});

	it("erkennt den Zusammenfassungsblock der Textfassung auch ohne Leerzeile", () => {
		// Die Aktivitaet "Abwesenheiten" darf dabei nicht mit abgeschnitten werden.
		const text = reportToText(report)
			.split("\n")
			.filter((l) => l.trim())
			.join("\n");
		const parsed = parseReportBody(text);
		expect(parsed!.lines).toEqual([
			{ name: "Projekt Alpha", hours: 10.5 },
			{ name: "Projekt Beta", hours: 4 },
			{ name: "Abwesenheiten", hours: 7.5 }
		]);
		expect(parsed!.total).toBe(report.total);
	});

	it("faellt nicht auf Zahlen aus einer Signatur herein", () => {
		// Zwei Zeilen, zwei Zahlen, keine Summe – das ist eine Signatur, kein Bericht.
		const signatur = `<table>
			<tr><td>Telefon</td><td>4711</td></tr>
			<tr><td>Mobil</td><td>0170</td></tr>
		</table>`;
		expect(parseReportBody(signatur)).toBeNull();
	});

	it("faellt nicht auf „Wort: Zahl“ im Fliesstext herein", () => {
		expect(parseReportBody("<p>Melde mich später.</p><p>Telefon: 4711</p>")).toBeNull();
	});

	it("liefert null statt geratener Zahlen bei fremdem Inhalt", () => {
		expect(parseReportBody("<p>Hallo, meine Stunden schicke ich morgen.</p>")).toBeNull();
		expect(parseReportBody("")).toBeNull();
		// Eine einzelne Zeile ohne Summe ist keine Berichtstabelle.
		expect(parseReportBody("<table><tr><td>Mobil</td><td>0170</td></tr></table>")).toBeNull();
	});
});

// ---- Monat ----

describe("monthFromSubject", () => {
	it("liest den Monat aus dem Standard-Betreff der App", () => {
		const subject = reportSubject("Stundenerfassung {month} – {name}", report.label, "Anna");
		expect(monthFromSubject(subject)).toBe("2026-07");
	});

	it("versteht alle Monatsnamen und das ISO-Format", () => {
		expect(monthFromSubject("Stundenerfassung März 2026")).toBe("2026-03");
		expect(monthFromSubject("Stunden Dezember 2025 – Klein")).toBe("2025-12");
		expect(monthFromSubject("Report 2026-01")).toBe("2026-01");
	});

	it("liefert null ohne Monatsangabe", () => {
		expect(monthFromSubject("Stundenerfassung")).toBeNull();
	});
});

describe("nameFromSubject", () => {
	it("liest den Namen aus der Betreff-Vorlage", () => {
		expect(nameFromSubject("Stundenerfassung Juli 2026 – Anna Meier")).toBe("Anna Meier");
		expect(nameFromSubject("Stundenerfassung Juli 2026 - Bert Klein")).toBe("Bert Klein");
	});

	it("liefert null, wenn hinten kein Name steht", () => {
		expect(nameFromSubject("Stundenerfassung Juli 2026")).toBeNull();
		expect(nameFromSubject("Stundenerfassung – Juli 2026")).toBeNull();
	});
});

describe("monthFromReceived", () => {
	it("rechnet fruehe Mails dem Vormonat zu", () => {
		expect(monthFromReceived(new Date(2026, 7, 3, 8, 0).getTime())).toBe("2026-07");
		expect(monthFromReceived(new Date(2026, 0, 5, 8, 0).getTime())).toBe("2025-12");
	});

	it("rechnet spaete Mails dem laufenden Monat zu", () => {
		expect(monthFromReceived(new Date(2026, 6, 31, 16, 0).getTime())).toBe("2026-07");
	});
});

describe("scanRange", () => {
	it("sucht vom Monatsersten bis zum 20. des Folgemonats", () => {
		expect(scanRange("2026-07")).toEqual({ start: "2026-07-01", end: "2026-08-20" });
		expect(scanRange("2026-12")).toEqual({ start: "2026-12-01", end: "2027-01-20" });
	});
});

// ---- Zusammenfassung ----

describe("buildTeamSummary", () => {
	it("ordnet Berichte den Teammitgliedern zu (Adresse ohne Ruecksicht auf Gross/Klein)", () => {
		const s = buildTeamSummary(
			"2026-07",
			[
				mail(),
				mail({
					subject: "Stundenerfassung Juli 2026 – Bert Klein",
					senderName: "Bert Klein",
					senderEmail: "bert.klein@firma.de"
				})
			],
			team
		);
		expect(s.entries.map((e) => e.memberId)).toEqual(["m1", "m2"]);
		expect(s.entries.map((e) => e.name)).toEqual(["Anna Meier", "Bert Klein"]);
	});

	it("ordnet ueber den Namen im Betreff zu, wenn Outlook den Absender verschweigt", () => {
		// Genau der Fall, den die Richtlinie "PromptOOMAddressInformationAccess"
		// erzeugt: Betreff und Empfangszeit kommen an, Name und Adresse nicht.
		const s = buildTeamSummary(
			"2026-07",
			[mail({ senderName: "", senderEmail: "", body: "" })],
			team
		);
		expect(s.entries[0].memberId).toBe("m1");
		expect(s.entries[0].name).toBe("Anna Meier");
		expect(s.missing.map((m) => m.id)).toEqual(["m2", "m3"]);
	});

	it("laesst den Namen im Betreff NICHT ueber einen bekannten Absender siegen", () => {
		// Weitergeleiteter Bericht: der Betreff nennt Anna, geschickt hat ihn Bert.
		const s = buildTeamSummary(
			"2026-07",
			[mail({ senderEmail: "bert.klein@firma.de", senderName: "Bert Klein" })],
			team
		);
		expect(s.entries[0].memberId).toBe("m2");
	});

	it("trennt „kein Inhalt geladen“ von „fremdes Format“", () => {
		const ohneInhalt = buildTeamSummary("2026-07", [mail({ body: "" })], team);
		expect(ohneInhalt.entries[0].hasBody).toBe(false);
		expect(ohneInhalt.bodiesMissing).toBe(1);

		const fremd = buildTeamSummary("2026-07", [mail({ body: "<p>komme später</p>" })], team);
		expect(fremd.entries[0].hasBody).toBe(true);
		expect(fremd.entries[0].parsed).toBe(false);
		expect(fremd.bodiesMissing).toBe(0);
	});

	it("wirft zwei nicht zuzuordnende Berichte nicht in eine Zeile", () => {
		// Gesperrter Absender UND kein Name im Betreff: dann ist nichts bekannt,
		// woran sich die Personen unterscheiden liessen – zwei Mails muessen
		// trotzdem zwei Zeilen bleiben, sonst verschwindet stillschweigend eine.
		const anonym = { subject: "Stundenerfassung Juli 2026", senderName: "", senderEmail: "" };
		const s = buildTeamSummary(
			"2026-07",
			[
				mail({ ...anonym, received: new Date(2026, 7, 1, 9, 0).toISOString() }),
				mail({ ...anonym, received: new Date(2026, 7, 2, 9, 0).toISOString() })
			],
			team
		);
		expect(s.entries).toHaveLength(2);
	});

	it("meldet, wessen Bericht fehlt", () => {
		const s = buildTeamSummary("2026-07", [mail()], team);
		expect(s.missing.map((m) => m.id)).toEqual(["m2", "m3"]);
	});

	it("uebernimmt Absender ausserhalb des Teams, statt sie zu verwerfen", () => {
		const s = buildTeamSummary(
			"2026-07",
			[
				mail({
					subject: "Stundenerfassung Juli 2026 – Dora Extern",
					senderEmail: "extern@partner.de",
					senderName: "Dora Extern"
				})
			],
			team
		);
		expect(s.entries).toHaveLength(1);
		expect(s.entries[0].memberId).toBeNull();
		expect(s.entries[0].name).toBe("Dora Extern");
		// … und zaehlt trotzdem als "noch nicht gemeldet" fuer das echte Team.
		expect(s.missing).toHaveLength(3);
	});

	it("ignoriert Mails eines anderen Monats", () => {
		const s = buildTeamSummary(
			"2026-07",
			[mail({ subject: "Stundenerfassung Juni 2026 – Anna Meier" })],
			team
		);
		expect(s.entries).toHaveLength(0);
	});

	it("nimmt bei zwei Mails derselben Person die neuere (Korrektur)", () => {
		const alt = mail({ received: new Date(2026, 7, 1, 9, 0).toISOString() });
		const neu = mail({
			received: new Date(2026, 7, 3, 11, 0).toISOString(),
			body: reportHtml.replace("10:30", "12:00")
		});
		const s = buildTeamSummary("2026-07", [alt, neu], team);
		expect(s.entries).toHaveLength(1);
		expect(hoursFor(s.entries[0], "Projekt Alpha")).toBe(12);
	});

	it("faellt ohne Monat im Betreff auf das Empfangsdatum zurueck und sagt es", () => {
		const s = buildTeamSummary("2026-07", [mail({ subject: "Stundenerfassung" })], team);
		expect(s.entries[0].monthSource).toBe("received");
		const mitMonat = buildTeamSummary("2026-07", [mail()], team);
		expect(mitMonat.entries[0].monthSource).toBe("subject");
	});

	it("fuehrt unlesbare Mails als nicht gewertet mit, statt sie zu verschlucken", () => {
		const s = buildTeamSummary("2026-07", [mail({ body: "<p>Kommt später!</p>" })], team);
		expect(s.entries).toHaveLength(1);
		expect(s.entries[0].parsed).toBe(false);
		expect(s.entries[0].total).toBe(0);
	});

	it("bildet Spalten und Summen ueber das ganze Team", () => {
		const bert = reportToHtml(
			buildReport(
				"2026-07",
				[
					{ id: "b1", name: "Projekt Beta", sortOrder: 0, archived: false, isAbsence: false },
					{ id: "b2", name: "Projekt Gamma", sortOrder: 1, archived: false, isAbsence: false }
				],
				[entry("x1", "b1", 6, 3), entry("x2", "b2", 7, 5)],
				0.5,
				7.5,
				[1, 2, 3, 4, 5]
			)
		);
		const s = buildTeamSummary(
			"2026-07",
			[
				mail(),
				mail({
					senderEmail: "bert.klein@firma.de",
					senderName: "Bert Klein",
					subject: "Stundenerfassung Juli 2026 – Bert Klein",
					body: bert
				})
			],
			team
		);
		// Reihenfolge wie in den Berichten, nicht alphabetisch.
		expect(s.activities).toEqual([
			"Projekt Alpha",
			"Projekt Beta",
			"Abwesenheiten",
			"Projekt Gamma"
		]);
		expect(activityTotal(s, "Projekt Beta")).toBe(7); // 4 (Anna) + 3 (Bert)
		expect(activityTotal(s, "Projekt Gamma")).toBe(5);
		expect(s.total).toBe(report.total + 8);
	});
});

// ---- Ausgabe ----

describe("Ausgabe", () => {
	const summary = buildTeamSummary("2026-07", [mail()], team);

	it("nennt in der HTML-Tabelle auch die, von denen nichts kam", () => {
		const html = teamSummaryToHtml(summary);
		expect(html).toContain("Anna Meier");
		expect(html).toContain("Bert Klein");
		expect(html).toContain("kein Bericht");
		expect(html).toContain("Juli 2026");
	});

	it("maskiert Namen mit Sonderzeichen im HTML", () => {
		const s = buildTeamSummary(
			"2026-07",
			[mail({ senderName: "<script>x</script>", senderEmail: "x@y.de" })],
			[]
		);
		expect(teamSummaryToHtml(s)).not.toContain("<script>");
	});

	it("schreibt CSV mit Semikolon und deutschen Dezimalzahlen", () => {
		const csv = teamSummaryToCsv(summary);
		const rows = csv.split("\r\n");
		expect(rows[0]).toBe("Mitarbeiter;E-Mail;Status;Projekt Alpha;Projekt Beta;Abwesenheiten;Summe");
		expect(rows[1]).toContain("10,50");
		expect(rows.some((r) => r.startsWith("Bert Klein;") && r.includes("kein Bericht"))).toBe(true);
		expect(rows[rows.length - 1]).toContain("Summe;;;");
	});

	it("entschaerft Namen, die Excel als Formel lesen wuerde", () => {
		const s = buildTeamSummary(
			"2026-07",
			[mail({ senderName: "=1+1", senderEmail: "x@y.de" })],
			[]
		);
		expect(teamSummaryToCsv(s).split("\r\n")[1]).toMatch(/^'=1\+1;/);
	});

	it("schuetzt Semikolon im Namen vor dem Zerfallen in zwei Spalten", () => {
		const s = buildTeamSummary(
			"2026-07",
			[mail({ senderName: "Meier; Anna", senderEmail: "x@y.de" })],
			[]
		);
		expect(teamSummaryToCsv(s).split("\r\n")[1]).toContain('"Meier; Anna"');
	});
});
