import { describe, expect, it } from "vitest";
import { resolveStartTs, toStartArg } from "./startTime";

// Fester Bezugspunkt: 2026-07-08 14:00:00 lokale Zeit.
const NOW = new Date(2026, 6, 8, 14, 0, 0, 0).getTime();

describe("resolveStartTs", () => {
	it("liefert genau jetzt bei Preset 0 ohne Uhrzeit", () => {
		expect(resolveStartTs(0, "", NOW)).toBe(NOW);
	});

	it("zieht das Preset in Minuten ab", () => {
		expect(resolveStartTs(60, "", NOW)).toBe(NOW - 60 * 60_000);
		expect(resolveStartTs(15, "", NOW)).toBe(NOW - 15 * 60_000);
	});

	it("eine gesetzte Uhrzeit überschreibt das Preset", () => {
		// 13:00 an NOW-Tag = eine Stunde vor 14:00, unabhängig vom Preset.
		expect(resolveStartTs(30, "13:00", NOW)).toBe(new Date(2026, 6, 8, 13, 0, 0, 0).getTime());
	});

	it("noch nicht erreichte Uhrzeit meint gestern", () => {
		// 15:00 ist um 14:00 noch nicht gewesen -> gemeint ist gestern 15:00.
		expect(resolveStartTs(0, "15:00", NOW)).toBe(new Date(2026, 6, 7, 15, 0, 0, 0).getTime());
	});

	it("23:00 kurz nach Mitternacht meint die vergangene Nacht", () => {
		// Genau der Fall: es ist 01:10, Eingabe 23:00.
		const nachts = new Date(2026, 6, 17, 1, 10, 0, 0).getTime();
		expect(resolveStartTs(0, "23:00", nachts)).toBe(new Date(2026, 6, 16, 23, 0, 0, 0).getTime());
	});

	it("liegt der Start nie in der Zukunft", () => {
		for (const t of ["00:00", "13:59", "14:01", "23:59"]) {
			expect(resolveStartTs(0, t, NOW)!, t).toBeLessThanOrEqual(NOW);
		}
	});

	it("greift ueber DST-Grenzen auf den Vortag (25-Stunden-Tag)", () => {
		// 26.10.2026 01:00, Eingabe 23:00 -> 25.10. 23:00 (Tag der Zeitumstellung).
		const nach = new Date(2026, 9, 26, 1, 0, 0, 0).getTime();
		const ts = resolveStartTs(0, "23:00", nach)!;
		const d = new Date(ts);
		expect(d.getDate()).toBe(25);
		expect(d.getHours()).toBe(23);
	});

	it("ungültige Uhrzeit-Eingabe ist null", () => {
		expect(resolveStartTs(0, "25:99", NOW)).toBeNull();
	});
});

describe("toStartArg", () => {
	it("behandelt 'praktisch jetzt' als undefined (kein Rückdatieren)", () => {
		expect(toStartArg(NOW, NOW)).toBeUndefined();
		expect(toStartArg(NOW - 500, NOW)).toBeUndefined();
	});

	it("gibt echte Rückdatierung als Zeitstempel zurück", () => {
		const past = NOW - 60 * 60_000;
		expect(toStartArg(past, NOW)).toBe(past);
	});
});
