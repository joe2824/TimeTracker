import { describe, expect, it } from "vitest";
import { reportReminderDate } from "../report/report";
import { wallToTs, zonedParts } from "../time/tz";
import { nextReminderDelay } from "./reminders";

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

describe("nextReminderDelay", () => {
	const NOW = wallToTs(2026, 7, 8, 10, 0, 0);

	it("nimmt die nächste Uhrzeit heute", () => {
		expect(nextReminderDelay(["09:00", "16:30"], NOW)).toBe(6.5 * 3_600_000);
	});

	it("geht auf morgen, wenn heute alles vorbei ist", () => {
		expect(nextReminderDelay(["09:00"], NOW)).toBe(23 * 3_600_000);
	});

	// setTimeout(NaN) feuert sofort – und plant danach wieder NaN: Dauerfeuer.
	it("überspringt unmögliche Uhrzeiten statt NaN zu liefern", () => {
		expect(nextReminderDelay(["24:00", "7:60", "quatsch"], NOW)).toBeNull();
		expect(nextReminderDelay(["24:00", "12:00"], NOW)).toBe(2 * 3_600_000);
	});

	it("liefert ohne Uhrzeiten nichts", () => {
		expect(nextReminderDelay([], NOW)).toBeNull();
	});
});
