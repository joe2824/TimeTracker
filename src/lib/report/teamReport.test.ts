import { describe, expect, it } from "vitest";
import { teamReminderHtml, teamReminderSubject, teamReportsToCsv } from "./teamReport";
import { wallToTs } from "../time/tz";
import type { TeamReportStatus } from "../sync/api";

function status(over: Partial<TeamReportStatus> = {}): TeamReportStatus {
	return {
		memberId: "m1",
		memberName: "Anna Meier",
		memberEmail: "anna.meier@firma.de",
		submittedAt: null,
		payload: null,
		...over
	};
}

describe("teamReportsToCsv", () => {
	it("nennt Abgegebene und Fehlende mit Status und Zeitpunkt", () => {
		// new Date(...) haengt an der Zone des Testrechners; fmtDate/fmtClock
		// lesen die gepinnte Konto-Zone (siehe testing/pinZone.ts) - ohne
		// wallToTs klafft das auf Maschinen ausserhalb dieser Zone auseinander.
		const submittedAt = wallToTs(2026, 8, 1, 9, 30, 0);
		const rows = teamReportsToCsv([
			status({ submittedAt }),
			status({ memberId: "m2", memberName: "Bert Schulz", memberEmail: null })
		]).split("\r\n");
		expect(rows[0]).toBe("Mitarbeiter;E-Mail;Status;Eingegangen am");
		expect(rows[1]).toBe("Anna Meier;anna.meier@firma.de;abgegeben;2026-08-01 09:30");
		expect(rows[2]).toBe("Bert Schulz;;kein Bericht;");
	});

	it("entschaerft Namen, die Excel als Formel lesen wuerde", () => {
		const rows = teamReportsToCsv([status({ memberName: "=1+1" })]).split("\r\n");
		expect(rows[1]).toMatch(/^'=1\+1;/);
	});

	it("entschaerft auch ein führendes Minus", () => {
		const rows = teamReportsToCsv([status({ memberName: "-1+SUMME(A1)" })]).split("\r\n");
		expect(rows[1]).toMatch(/^'-1\+SUMME\(A1\);/);
	});

	it("schuetzt Semikolon im Namen vor dem Zerfallen in zwei Spalten", () => {
		const rows = teamReportsToCsv([status({ memberName: "Meier; Anna" })]).split("\r\n");
		expect(rows[1]).toContain('"Meier; Anna"');
	});
});

describe("Erinnerung", () => {
	it("baut Betreff und Text ohne Namensliste", () => {
		expect(teamReminderSubject("Juli 2026")).toBe("Stundenerfassung Juli 2026 – Erinnerung");
		const html = teamReminderHtml("Juli 2026");
		expect(html).toContain("Juli 2026");
		expect(html).not.toContain("Bert");
	});
});
