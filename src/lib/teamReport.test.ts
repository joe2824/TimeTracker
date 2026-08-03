import { describe, expect, it } from "vitest";
import { reportSubject } from "./report";
import {
	buildTeamSummary,
	monthFromReceived,
	monthFromSubject,
	nameFromSubject,
	scanRange,
	teamReminderHtml,
	teamReminderSubject,
	teamSummaryToCsv
} from "./teamReport";
import type { TeamMember } from "./types";

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
		...over
	};
}

// ---- Monat und Name aus dem Betreff ----

describe("monthFromSubject", () => {
	it("liest den Monat aus dem Standard-Betreff der App", () => {
		const subject = reportSubject("Stundenerfassung {month} – {name}", "Juli 2026", "Anna");
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

	it("findet den Namen auch VOR dem Betreff, ohne Trennstrich", () => {
		// Echte Form aus dem Postfach – der Name steht vorne, kein Gedankenstrich.
		expect(nameFromSubject("Anna Meier Stundenerfassung Juli 2026", "Stundenerfassung")).toBe(
			"Anna Meier"
		);
	});

	it("laesst nichts uebrig, wenn im Betreff nur Merkmal und Monat stehen", () => {
		expect(nameFromSubject("Stundenerfassung Juli 2026", "Stundenerfassung")).toBeNull();
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

// ---- Abgabe-Uebersicht ----

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

	it("meldet, wessen Bericht fehlt", () => {
		const s = buildTeamSummary("2026-07", [mail()], team);
		expect(s.missing.map((m) => m.id)).toEqual(["m2", "m3"]);
	});

	it("ordnet ueber den Namen im Betreff zu, wenn Outlook den Absender verschweigt", () => {
		// Der Normalfall auf gesperrten Rechnern: Betreff und Empfangszeit kommen
		// an, Name und Adresse nicht.
		const s = buildTeamSummary(
			"2026-07",
			[mail({ senderName: "", senderEmail: "" })],
			team
		);
		expect(s.entries[0].memberId).toBe("m1");
		expect(s.entries[0].name).toBe("Anna Meier");
		expect(s.missing.map((m) => m.id)).toEqual(["m2", "m3"]);
	});

	it("erkennt das Teammitglied, egal wo sein Name im Betreff steht", () => {
		// Der reale Fall: Absender gesperrt, Name vorne, Teameintrag nur "Anna".
		const eigenes: TeamMember[] = [
			{ id: "j", name: "Anna", email: "anna.meier@firma.de" },
			{ id: "h", name: "Bernd", email: "bernd.mueller@firma.de" }
		];
		const s = buildTeamSummary(
			"2026-07",
			[
				mail({
					subject: "Anna Meier Stundenerfassung Juli 2026",
					senderName: "",
					senderEmail: ""
				})
			],
			eigenes,
			"Stundenerfassung"
		);
		expect(s.entries[0].memberId).toBe("j");
		expect(s.entries[0].name).toBe("Anna");
		expect(s.missing.map((m) => m.id)).toEqual(["h"]);
	});

	it("verwechselt Namen nicht mit laengeren Woertern", () => {
		// "Klein" darf nicht auf "Kleinschmidt" passen – wortweise, nicht Teilstring.
		const s = buildTeamSummary(
			"2026-07",
			[
				mail({
					subject: "Anna Kleinschmidt Stundenerfassung Juli 2026",
					senderName: "",
					senderEmail: ""
				})
			],
			[{ id: "k", name: "Klein", email: "klein@firma.de" }],
			"Stundenerfassung"
		);
		expect(s.entries[0].memberId).toBeNull();
		expect(s.entries[0].name).toBe("Anna Kleinschmidt");
	});

	it("nimmt bei mehreren passenden Teamnamen den genaueren", () => {
		const s = buildTeamSummary(
			"2026-07",
			[mail({ subject: "Anna Meier Stundenerfassung Juli 2026", senderName: "", senderEmail: "" })],
			[
				{ id: "kurz", name: "Anna", email: "a@firma.de" },
				{ id: "lang", name: "Anna Meier", email: "b@firma.de" }
			],
			"Stundenerfassung"
		);
		expect(s.entries[0].memberId).toBe("lang");
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
		const s = buildTeamSummary(
			"2026-07",
			[
				mail({ received: new Date(2026, 7, 1, 9, 0).toISOString() }),
				mail({ received: new Date(2026, 7, 3, 11, 0).toISOString() })
			],
			team
		);
		expect(s.entries).toHaveLength(1);
		expect(s.entries[0].receivedTs).toBe(new Date(2026, 7, 3, 11, 0).getTime());
	});

	it("faellt ohne Monat im Betreff auf das Empfangsdatum zurueck und sagt es", () => {
		const s = buildTeamSummary("2026-07", [mail({ subject: "Stundenerfassung" })], team);
		expect(s.entries[0].monthSource).toBe("received");
		const mitMonat = buildTeamSummary("2026-07", [mail()], team);
		expect(mitMonat.entries[0].monthSource).toBe("subject");
	});
});

// ---- Ausgabe ----

describe("Ausgabe", () => {
	const summary = buildTeamSummary("2026-07", [mail()], team);

	it("nennt in der CSV auch die, von denen nichts kam", () => {
		const rows = teamSummaryToCsv(summary).split("\r\n");
		expect(rows[0]).toBe("Mitarbeiter;E-Mail;Status;Eingegangen am");
		expect(rows[1]).toBe("Anna Meier;anna.meier@firma.de;abgegeben;2026-08-01 09:30");
		expect(rows.some((r) => r.startsWith("Bert Klein;") && r.includes("kein Bericht"))).toBe(true);
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

	it("baut Betreff und Text der Erinnerung ohne Namensliste", () => {
		expect(teamReminderSubject("Juli 2026")).toBe("Stundenerfassung Juli 2026 – Erinnerung");
		const html = teamReminderHtml("Juli 2026");
		expect(html).toContain("Juli 2026");
		expect(html).not.toContain("Bert");
	});
});
