import { describe, expect, it } from "vitest";
import { reportReminderDate } from "./report";

/** Referenzmonat: Juli 2026 – letzter Tag ist Fr, 31.07. */
const JULI = new Date(2026, 6, 1);

describe("reportReminderDate", () => {
	it("trifft den letzten Werktag des Monats", () => {
		const d = reportReminderDate(JULI, "16:00", 0);
		expect(d.getDate()).toBe(31);
		expect(d.getDay()).toBe(5); // Freitag
		expect(d.getHours()).toBe(16);
	});

	it("überspringt das Wochenende rückwärts", () => {
		// Mai 2026 endet an einem Sonntag (31.05.) -> Freitag 29.05.
		const d = reportReminderDate(new Date(2026, 4, 1), "16:00", 0);
		expect(d.getDate()).toBe(29);
		expect(d.getDay()).toBe(5);
	});

	it("geht `lead` Werktage zurück", () => {
		const d = reportReminderDate(JULI, "16:00", 2);
		expect(d.getDate()).toBe(29); // Fr 31. -> Do 30. -> Mi 29.
	});

	it("nimmt Stunde 0 ernst", () => {
		// `h || 16` machte aus 00:30 die Uhrzeit 16:30 – Stunde 0 ist falsy.
		const d = reportReminderDate(JULI, "00:30", 0);
		expect(d.getHours()).toBe(0);
		expect(d.getMinutes()).toBe(30);
	});

	it("fällt bei unlesbarer Uhrzeit auf 16:00 zurück", () => {
		const d = reportReminderDate(JULI, "quatsch", 0);
		expect(d.getHours()).toBe(16);
		expect(d.getMinutes()).toBe(0);
	});
});
