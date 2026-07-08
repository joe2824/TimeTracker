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

	it("Uhrzeit in der Zukunft ist ungültig", () => {
		expect(resolveStartTs(0, "15:00", NOW)).toBeNull();
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
