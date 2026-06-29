import { describe, expect, it } from "vitest";
import {
	clockToMin,
	durationHours,
	durationSeconds,
	entryHours,
	fmtHMS,
	fmtHours,
	fmtHoursClock,
	minToClock,
	monthLabel,
	parseClock,
	parseHours,
	roundHours
} from "./time";
import type { Entry } from "./types";

describe("roundHours", () => {
	it("rundet auf halbe Stunden", () => {
		expect(roundHours(2.0, 0.5)).toBe(2.0);
		expect(roundHours(2.2, 0.5)).toBe(2.0);
		expect(roundHours(2.3, 0.5)).toBe(2.5);
		expect(roundHours(1.333, 0.5)).toBe(1.5);
	});

	it("rundet auf Viertelstunden", () => {
		expect(roundHours(2.74, 0.25)).toBe(2.75);
		expect(roundHours(2.6, 0.25)).toBe(2.5);
	});

	it("rundet auf volle Stunden", () => {
		expect(roundHours(2.4, 1)).toBe(2);
		expect(roundHours(2.5, 1)).toBe(3);
	});

	it("lässt bei step<=0 unverändert", () => {
		expect(roundHours(1.23, 0)).toBe(1.23);
	});
});

describe("fmtHMS", () => {
	it("formatiert Sekunden als H:MM:SS", () => {
		expect(fmtHMS(0)).toBe("0:00:00");
		expect(fmtHMS(59)).toBe("0:00:59");
		expect(fmtHMS(3661)).toBe("1:01:01");
		expect(fmtHMS(-5)).toBe("0:00:00");
	});
});

describe("fmtHours", () => {
	it("nutzt deutsches Dezimalkomma", () => {
		expect(fmtHours(2.5)).toBe("2,5");
		expect(fmtHours(0)).toBe("0,0");
		expect(fmtHours(4)).toBe("4,0");
	});
});

describe("fmtHoursClock", () => {
	it("formatiert Stunden als Zeitformat H:MM", () => {
		expect(fmtHoursClock(7.5)).toBe("7:30");
		expect(fmtHoursClock(8)).toBe("8:00");
		expect(fmtHoursClock(40)).toBe("40:00");
		expect(fmtHoursClock(0)).toBe("0:00");
		expect(fmtHoursClock(3.75)).toBe("3:45");
		expect(fmtHoursClock(0.25)).toBe("0:15");
	});

	it("rundet auf ganze Minuten", () => {
		expect(fmtHoursClock(1.008)).toBe("1:00");
	});
});

describe("durationSeconds", () => {
	it("berechnet abgeschlossene Dauer", () => {
		const e: Entry = {
			id: "1",
			activityId: "a",
			startTs: 1_000_000,
			endTs: 1_000_000 + 7200 * 1000,
			note: "",
			source: "manual"
		};
		expect(durationSeconds(e)).toBe(7200);
	});

	it("nutzt now für laufende Einträge", () => {
		const start = 1_000_000;
		const now = start + 1800 * 1000;
		const e: Entry = { id: "1", activityId: "a", startTs: start, endTs: null, note: "", source: "timer" };
		expect(durationSeconds(e, now)).toBe(1800);
	});
});

describe("entryHours", () => {
	const base = { id: "1", activityId: "a", note: "", source: "manual" as const };

	it("rechnet Arbeit aus der Dauer", () => {
		const e: Entry = { ...base, startTs: 0, endTs: 9000 * 1000 };
		expect(entryHours(e, false, 7.5)).toBe(2.5);
	});

	it("rechnet Abwesenheit aus Tagesanteil * hoursPerDay", () => {
		const full: Entry = { ...base, startTs: 0, endTs: 0, dayFraction: 1 };
		const half: Entry = { ...base, startTs: 0, endTs: 0, dayFraction: 0.5 };
		const none: Entry = { ...base, startTs: 0, endTs: 0 };
		expect(entryHours(full, true, 7.5)).toBe(7.5);
		expect(entryHours(half, true, 7.5)).toBe(3.75);
		expect(entryHours(none, true, 8)).toBe(8); // ohne dayFraction = ganzer Tag
	});
});

describe("monthLabel", () => {
	it("gibt deutschen Monatsnamen", () => {
		expect(monthLabel("2026-06")).toBe("Juni 2026");
		expect(monthLabel("2026-01")).toBe("Januar 2026");
	});
});

describe("clockToMin", () => {
	it("parst gültige Zeiten", () => {
		expect(clockToMin("00:00")).toBe(0);
		expect(clockToMin("09:30")).toBe(570);
		expect(clockToMin("23:59")).toBe(1439);
		expect(clockToMin(" 8:05 ")).toBe(485);
	});

	it("gibt null bei ungültiger Eingabe", () => {
		expect(clockToMin("")).toBeNull();
		expect(clockToMin("24:00")).toBeNull();
		expect(clockToMin("12:60")).toBeNull();
		expect(clockToMin("abc")).toBeNull();
	});
});

describe("minToClock", () => {
	it("formatiert Minuten als HH:MM", () => {
		expect(minToClock(0)).toBe("00:00");
		expect(minToClock(570)).toBe("09:30");
		expect(minToClock(1439)).toBe("23:59");
	});

	it("rechnet modulo 24h und rundet", () => {
		expect(minToClock(1440)).toBe("00:00");
		expect(minToClock(1500)).toBe("01:00");
		expect(minToClock(-60)).toBe("23:00");
		expect(minToClock(90.6)).toBe("01:31");
	});
});

describe("parseClock", () => {
	it("parst Ziffern ohne Trenner", () => {
		expect(parseClock("1800")).toBe("18:00");
		expect(parseClock("830")).toBe("08:30");
		expect(parseClock("8")).toBe("08:00");
		expect(parseClock("18")).toBe("18:00");
		expect(parseClock("0")).toBe("00:00");
	});

	it("parst mit Trenner", () => {
		expect(parseClock("18:00")).toBe("18:00");
		expect(parseClock("8:05")).toBe("08:05");
		expect(parseClock("18.30")).toBe("18:30");
		expect(parseClock("18,30")).toBe("18:30");
		expect(parseClock("18h30")).toBe("18:30");
	});

	it("gibt null bei ungültiger Eingabe", () => {
		expect(parseClock("")).toBeNull();
		expect(parseClock("2500")).toBeNull();
		expect(parseClock("18:60")).toBeNull();
		expect(parseClock("12345")).toBeNull();
		expect(parseClock("abc")).toBeNull();
	});
});

describe("parseHours", () => {
	it("parst Dezimaleingabe mit Komma und Punkt", () => {
		expect(parseHours("7,5")).toBe(7.5);
		expect(parseHours("7.5")).toBe(7.5);
		expect(parseHours("0")).toBe(0);
		expect(parseHours(" 1,25 ")).toBe(1.25);
	});

	it("parst Uhrzeit-Format", () => {
		expect(parseHours("7:30")).toBe(7.5);
		expect(parseHours("0:15")).toBe(0.25);
		expect(parseHours("8:00")).toBe(8);
	});

	it("gibt null bei ungültiger Eingabe", () => {
		expect(parseHours("")).toBeNull();
		expect(parseHours("abc")).toBeNull();
		expect(parseHours("7:60")).toBeNull();
		expect(parseHours("30:00")).toBeNull(); // Uhrzeit-Format: Stunden 0–23
		expect(parseHours("-1")).toBeNull();
	});

	it("lässt große Dezimalsummen zu (Monatspauschale)", () => {
		expect(parseHours("80")).toBe(80);
		expect(parseHours("37,5")).toBe(37.5);
	});

	it("parst vierstellige HHMM-Eingabe als Uhrzeit, nicht als Stundenzahl", () => {
		expect(parseHours("0741")).toBeCloseTo(7 + 41 / 60, 10); // war fälschlich 741
		expect(parseHours("1230")).toBe(12.5);
		expect(parseHours("0800")).toBe(8);
		expect(parseHours("0015")).toBe(0.25);
		// ungültige HHMM (Minuten > 59) fällt auf Dezimal zurück
		expect(parseHours("2575")).toBe(2575);
	});
});

describe("durationHours", () => {
	it("berechnet Dauer zwischen zwei Zeiten", () => {
		expect(durationHours("09:00", "10:30")).toBe(1.5);
		expect(durationHours("08:00", "08:00")).toBe(0);
	});

	it("zählt über Mitternacht +24h", () => {
		expect(durationHours("23:00", "01:00")).toBe(2);
	});

	it("gibt 0 bei ungültiger Eingabe", () => {
		expect(durationHours("", "10:00")).toBe(0);
		expect(durationHours("09:00", "xx")).toBe(0);
	});

	it("ist invers zu minToClock (Von + Stunden = Bis)", () => {
		const start = clockToMin("09:00")!;
		const end = minToClock(start + 1.5 * 60);
		expect(end).toBe("10:30");
		expect(durationHours("09:00", end)).toBe(1.5);
	});
});
