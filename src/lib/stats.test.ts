import { describe, expect, it } from "vitest";
import { dayActivityHours, dayWorkHours, heatmapYear, targetHours } from "./stats";
import type { Entry } from "./types";

const ABS = "abs";
const MO_FR = [1, 2, 3, 4, 5];

/** Eintrag am lokalen Tag `d` (Monat 1-basiert) ueber `hours` Stunden ab 08:00. */
function e(id: string, activityId: string, y: number, m: number, d: number, hours: number): Entry {
	const start = new Date(y, m - 1, d, 8, 0, 0).getTime();
	return {
		id,
		activityId,
		startTs: start,
		endTs: start + hours * 3600 * 1000,
		note: "",
		source: "manual"
	};
}

describe("dayWorkHours", () => {
	it("summiert mehrere Eintraege am selben Tag", () => {
		const map = dayWorkHours([e("1", "a", 2026, 6, 10, 4), e("2", "b", 2026, 6, 10, 2.5)], new Set());
		expect(map.get("2026-06-10")).toBeCloseTo(6.5);
	});

	it("laesst Abwesenheiten weg – Urlaub ist keine gearbeitete Zeit", () => {
		const map = dayWorkHours(
			[e("1", "a", 2026, 6, 10, 4), e("2", ABS, 2026, 6, 11, 0)],
			new Set([ABS])
		);
		expect(map.get("2026-06-10")).toBeCloseTo(4);
		expect(map.has("2026-06-11")).toBe(false);
	});

	it("rechnet einen laufenden Eintrag bis now", () => {
		const start = new Date(2026, 5, 10, 8, 0, 0).getTime();
		const running: Entry = { id: "r", activityId: "a", startTs: start, endTs: null, note: "", source: "timer" };
		const map = dayWorkHours([running], new Set(), start + 2 * 3600 * 1000);
		expect(map.get("2026-06-10")).toBeCloseTo(2);
	});
});

describe("dayActivityHours", () => {
	it("schluesselt einen Tag nach Aktivitaet auf", () => {
		const map = dayActivityHours(
			[e("1", "a", 2026, 6, 10, 4), e("2", "b", 2026, 6, 10, 2.5), e("3", "a", 2026, 6, 10, 1)],
			new Set()
		);
		const day = map.get("2026-06-10")!;
		expect(day.get("a")).toBeCloseTo(5); // zwei Eintraege derselben Aktivitaet summiert
		expect(day.get("b")).toBeCloseTo(2.5);
	});

	it("haelt Tage auseinander", () => {
		const map = dayActivityHours([e("1", "a", 2026, 6, 10, 4), e("2", "a", 2026, 6, 11, 3)], new Set());
		expect(map.get("2026-06-10")!.get("a")).toBeCloseTo(4);
		expect(map.get("2026-06-11")!.get("a")).toBeCloseTo(3);
	});

	it("laesst Abwesenheiten weg", () => {
		const map = dayActivityHours([e("1", ABS, 2026, 6, 10, 0)], new Set([ABS]));
		expect(map.size).toBe(0);
	});
});

describe("targetHours", () => {
	it("zaehlt die Werktage eines abgeschlossenen Monats", () => {
		// Juni 2026: 22 Werktage (Mo-Fr).
		const now = new Date(2026, 7, 1).getTime(); // August -> Juni ist Vergangenheit
		expect(targetHours("2026-06", MO_FR, 7.5, now)).toBeCloseTo(22 * 7.5);
	});

	it("zaehlt im laufenden Monat nur bis heute", () => {
		// 10.06.2026 ist ein Mittwoch -> Werktage 1..10 = 8.
		const now = new Date(2026, 5, 10, 12, 0, 0).getTime();
		expect(targetHours("2026-06", MO_FR, 7.5, now)).toBeCloseTo(8 * 7.5);
	});

	it("gibt 0 fuer kuenftige Monate", () => {
		const now = new Date(2026, 5, 10).getTime();
		expect(targetHours("2026-09", MO_FR, 7.5, now)).toBe(0);
	});

	it("respektiert abweichende Arbeitstage", () => {
		const now = new Date(2026, 7, 1).getTime();
		// Nur Montage im Juni 2026: 1., 8., 15., 22., 29. = 5.
		expect(targetHours("2026-06", [1], 8, now)).toBeCloseTo(5 * 8);
	});
});

describe("heatmapYear", () => {
	it("liefert volle Wochen zu je 7 Tagen", () => {
		const weeks = heatmapYear(2026, new Map());
		expect(weeks.every((w) => w.length === 7)).toBe(true);
		expect(weeks.length).toBeGreaterThanOrEqual(52);
		expect(weeks.length).toBeLessThanOrEqual(54);
	});

	it("beginnt an einem Montag und deckt das ganze Jahr ab", () => {
		const weeks = heatmapYear(2026, new Map());
		const all = weeks.flat();
		const real = all.filter((d) => !d.filler);
		expect(real[0].date).toBe("2026-01-01");
		expect(real[real.length - 1].date).toBe("2026-12-31");
		// 2026 ist kein Schaltjahr.
		expect(real).toHaveLength(365);
	});

	it("markiert Tage ausserhalb des Jahres als filler", () => {
		const weeks = heatmapYear(2026, new Map());
		// 1.1.2026 ist ein Donnerstag -> Mo..Mi davor sind Filler.
		expect(weeks[0].slice(0, 3).every((d) => d.filler)).toBe(true);
		expect(weeks[0][3].date).toBe("2026-01-01");
	});

	it("gibt Tagen ohne Stunden level 0", () => {
		const weeks = heatmapYear(2026, new Map([["2026-06-10", 8]]));
		const leer = weeks.flat().find((d) => d.date === "2026-06-11");
		expect(leer?.level).toBe(0);
	});

	it("staffelt die Level als Anteil am staerksten Tag", () => {
		const byDay = new Map([
			["2026-06-01", 3],
			["2026-06-02", 6],
			["2026-06-03", 9],
			["2026-06-04", 12]
		]);
		const days = heatmapYear(2026, byDay).flat();
		const level = (d: string) => days.find((x) => x.date === d)?.level;
		expect([level("2026-06-01"), level("2026-06-02"), level("2026-06-03"), level("2026-06-04")])
			.toEqual([1, 2, 3, 4]);
	});

	it("gibt dem staerksten Tag immer level 4 – auch als einzigem Tag", () => {
		const days = heatmapYear(2026, new Map([["2026-06-10", 8]])).flat();
		expect(days.find((d) => d.date === "2026-06-10")?.level).toBe(4);
	});

	it("laesst aehnliche Arbeitstage aehnlich aussehen", () => {
		// Realistische Streuung: Quartile wuerden hier ueber alle 4 Stufen spreizen.
		const byDay = new Map([
			["2026-06-01", 7.2],
			["2026-06-02", 7.5],
			["2026-06-03", 7.9],
			["2026-06-04", 8.0]
		]);
		const levels = heatmapYear(2026, byDay)
			.flat()
			.filter((d) => d.hours > 0)
			.map((d) => d.level);
		expect(new Set(levels).size).toBe(1);
	});

	it("ignoriert Stunden aus anderen Jahren", () => {
		const weeks = heatmapYear(2026, new Map([["2025-06-10", 8]]));
		expect(weeks.flat().every((d) => d.hours === 0)).toBe(true);
	});
});

describe("heatmapYear – Monatsanfaenge (Beschriftung der Heatmap)", () => {
	// Die Card sucht je Wochenspalte einen Tag, der auf den Monatsersten faellt.
	// Fruehere Fassung prueft nur den ersten Tag der Spalte -> Monate, die mitten
	// in der Woche starten, fielen weg (es blieben nur Jan und Jun uebrig).
	const ticksOf = (year: number) =>
		heatmapYear(year, new Map())
			.map((w) => w.find((d) => !d.filler && d.date.endsWith("-01")))
			.filter((d) => d !== undefined)
			.map((d) => d!.date);

	it("findet in jedem Jahr alle 12 Monatsanfaenge", () => {
		for (const y of [2024, 2025, 2026, 2027]) {
			expect(ticksOf(y), `Jahr ${y}`).toHaveLength(12);
		}
	});

	it("liefert sie in Reihenfolge Januar..Dezember", () => {
		expect(ticksOf(2026)).toEqual([
			"2026-01-01", "2026-02-01", "2026-03-01", "2026-04-01",
			"2026-05-01", "2026-06-01", "2026-07-01", "2026-08-01",
			"2026-09-01", "2026-10-01", "2026-11-01", "2026-12-01"
		]);
	});
});
