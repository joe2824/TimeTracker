import { describe, expect, it } from "vitest";
import { reportReminderDate } from "../report/report";
import { wallToTs, zonedParts } from "../time/tz";

/** Referenzmonat: Juli 2026 – letzter Tag ist Fr, 31.07. */
const JULY = new Date(wallToTs(2026, 7, 1, 0, 0, 0));

describe("reportReminderDate", () => {
	it("trifft den letzten Werktag des Monats", () => {
		const d = reportReminderDate(JULY, "16:00", 0);
		expect(zonedParts(d.getTime()).day).toBe(31);
		expect(zonedParts(d.getTime()).weekday).toBe(5); // Freitag
		expect(zonedParts(d.getTime()).hour).toBe(16);
	});

	it("überspringt das Wochenende rückwärts", () => {
		// Mai 2026 endet an einem Sonntag (31.05.) -> Freitag 29.05.
		const d = reportReminderDate(new Date(wallToTs(2026, 5, 1, 0, 0, 0)), "16:00", 0);
		expect(zonedParts(d.getTime()).day).toBe(29);
		expect(zonedParts(d.getTime()).weekday).toBe(5);
	});

	it("geht `lead` Werktage zurück", () => {
		const d = reportReminderDate(JULY, "16:00", 2);
		expect(zonedParts(d.getTime()).day).toBe(29); // Fr 31. -> Do 30. -> Mi 29.
	});

	it("nimmt Stunde 0 ernst", () => {
		// `h || 16` machte aus 00:30 die Uhrzeit 16:30 – Stunde 0 ist falsy.
		const d = reportReminderDate(JULY, "00:30", 0);
		expect(zonedParts(d.getTime()).hour).toBe(0);
		expect(zonedParts(d.getTime()).minute).toBe(30);
	});

	it("fällt bei unlesbarer Uhrzeit auf 16:00 zurück", () => {
		const d = reportReminderDate(JULY, "quatsch", 0);
		expect(zonedParts(d.getTime()).hour).toBe(16);
		expect(zonedParts(d.getTime()).minute).toBe(0);
	});
});
