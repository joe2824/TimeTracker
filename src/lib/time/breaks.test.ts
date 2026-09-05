import { describe, expect, it } from "vitest";
import { breakDeduction, deductBreakFromDay, deductBreakFromHours, grossForNet } from "./breaks";

describe("breakDeduction", () => {
	it("zieht ab 4 Stunden eine Viertelstunde ab", () => {
		expect(breakDeduction(4.01)).toBe(0.25);
		expect(breakDeduction(5)).toBe(0.25);
		expect(breakDeduction(6)).toBe(0.25);
	});

	it("zieht ab 6 Stunden dreiviertel Stunden ab", () => {
		expect(breakDeduction(6.01)).toBe(0.75);
		expect(breakDeduction(8)).toBe(0.75);
		expect(breakDeduction(12)).toBe(0.75);
	});

	it("laesst kurze Tage unangetastet", () => {
		expect(breakDeduction(0)).toBe(0);
		expect(breakDeduction(3.5)).toBe(0);
		// Genau vier Stunden brauchen noch keine Pause.
		expect(breakDeduction(4)).toBe(0);
	});
});

describe("deductBreakFromHours", () => {
	it("rechnet die Nettozeit eines Tages", () => {
		expect(deductBreakFromHours(8)).toBeCloseTo(7.25);
		expect(deductBreakFromHours(5)).toBeCloseTo(4.75);
		expect(deductBreakFromHours(3)).toBe(3);
	});

	it("schwellt auf der Brutto-, nicht auf der Nettozeit", () => {
		// 6,2 h brutto ergeben 5,45 h netto. Auf der Nettozeit geschwellt laege man
		// wieder unter 6 h und der Abzug haette sich selbst aufgehoben.
		expect(deductBreakFromHours(6.2)).toBeCloseTo(5.45);
	});

	it("wird nie negativ", () => {
		expect(deductBreakFromHours(0)).toBe(0);
	});
});

describe("deductBreakFromDay", () => {
	it("verteilt den Abzug anteilig auf die Aktivitaeten", () => {
		// 5 h + 2 h = 7 h -> ueber 6 h, also 45 Minuten auf beide verteilt.
		const out = deductBreakFromDay(new Map([["a", 5], ["b", 2]]));
		expect(out.get("a")).toBeCloseTo(5 * (6.25 / 7), 6);
		expect(out.get("b")).toBeCloseTo(2 * (6.25 / 7), 6);
		// Die Summe stimmt exakt.
		expect([...out.values()].reduce((s, h) => s + h, 0)).toBeCloseTo(6.25, 6);
	});

	it("schwellt auf der Tagessumme, nicht je Aktivitaet", () => {
		// Zwei Aktivitaeten mit je 3,5 h sind einzeln unter 4 h, zusammen aber
		// 7 h – der Abzug richtet sich nach dem Tag, nicht nach dem Eintrag.
		const out = deductBreakFromDay(new Map([["a", 3.5], ["b", 3.5]]));
		expect([...out.values()].reduce((s, h) => s + h, 0)).toBeCloseTo(6.25, 6);
	});

	it("ist unabhaengig von der Reihenfolge der Aktivitaeten", () => {
		const a = deductBreakFromDay(new Map([["x", 2], ["y", 3]]));
		const b = deductBreakFromDay(new Map([["y", 3], ["x", 2]]));
		expect(a.get("x")).toBeCloseTo(b.get("x")!, 9);
		expect(a.get("y")).toBeCloseTo(b.get("y")!, 9);
	});

	it("laesst einen kurzen Tag unveraendert", () => {
		const input = new Map([["a", 2], ["b", 1]]);
		expect(deductBreakFromDay(input)).toEqual(input);
	});

	it("kommt mit einem leeren Tag zurecht", () => {
		expect([...deductBreakFromDay(new Map()).entries()]).toEqual([]);
	});

	it("traegt den Abzug auch bei einer einzigen Aktivitaet", () => {
		const out = deductBreakFromDay(new Map([["a", 9.65]]));
		expect(out.get("a")).toBeCloseTo(8.9, 6);
	});
});

describe("grossForNet", () => {
	it("kehrt den Abzug um", () => {
		// Echte Zeilen aus dem Zeitwirtschaftsreport.
		expect(grossForNet(7.67)).toBeCloseTo(8.42, 6);
		expect(grossForNet(5.73)).toBeCloseTo(5.98, 6);
		expect(grossForNet(3)).toBe(3);
	});

	it("liefert die kleinste passende Anwesenheit", () => {
		// 5,98 h und 6,48 h ergeben beide 5,73 h netto – die groessere entstuende
		// nur durch eine Pause, die niemand gemacht hat.
		expect(grossForNet(5.73)).toBeLessThan(6);
	});

	it("ist zur Abzugsrechnung konsistent", () => {
		for (const net of [1, 3.9, 4.5, 5.73, 6.5, 7.67, 9, 11.25]) {
			expect(deductBreakFromHours(grossForNet(net))).toBeCloseTo(net, 6);
		}
	});

	it("liefert nichts fuer nichts", () => {
		expect(grossForNet(0)).toBe(0);
		expect(grossForNet(-1)).toBe(0);
	});
});
