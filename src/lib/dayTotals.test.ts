import { describe, expect, it } from "vitest";
import { dayTotals } from "./dayTotals";
import type { Entry } from "./types";
import { wallToTs } from "./tz";

const HPD = 7.5;
const ABS = "abs";
const ABSENCES = new Set([ABS]);
const at = (h: number, min = 0) => wallToTs(2026, 9, 1, h, min, 0);

const work = (id: string, from: number, to: number, toMin = 0): Entry => ({
	id,
	activityId: "p1",
	startTs: at(from),
	endTs: at(to, toMin),
	note: "",
	source: "manual"
});

const dayEntry = (id: string, fraction: number, timeOff = false): Entry => {
	const noon = at(12);
	const e: Entry = {
		id,
		activityId: ABS,
		startTs: noon,
		endTs: noon,
		note: "",
		source: "manual",
		dayFraction: fraction
	};
	if (timeOff) e.timeOff = true;
	return e;
};

describe("dayTotals", () => {
	it("zaehlt reine Projektzeit", () => {
		expect(dayTotals([work("1", 8, 16)], ABSENCES, HPD).total).toBe(8);
	});

	it("zaehlt einen Urlaubstag als erfuellte Zeit", () => {
		// Ein Urlaubstag fuellt das Tagessoll - er ist kein Minus.
		expect(dayTotals([dayEntry("u", 1)], ABSENCES, HPD).total).toBe(7.5);
	});

	it("zaehlt einen ganzen Tag Zeitausgleich wie eine Abwesenheit", () => {
		// Er fuellt das Tagessoll wie ein Urlaubstag - getrennt gefuehrt wird er nur,
		// damit die Auswertung "davon Zeitausgleich" zeigen kann.
		const totals = dayTotals([dayEntry("z", 1, true)], ABSENCES, HPD);
		expect(totals.timeOff).toBe(7.5);
		expect(totals.absent).toBe(0);
		expect(totals.total).toBe(7.5);
	});

	it("zaehlt den halben Tag halb", () => {
		expect(dayTotals([dayEntry("z", 0.5, true)], ABSENCES, HPD).total).toBe(3.75);
	});

	it("verrechnet Arbeit am Vormittag mit einem halben Tag Zeitausgleich", () => {
		// Der uebliche Fall: vormittags arbeiten, nachmittags abfeiern.
		const totals = dayTotals([work("1", 8, 11, 45), dayEntry("z", 0.5, true)], ABSENCES, HPD);
		expect(totals.worked).toBe(3.75);
		expect(totals.total).toBe(7.5);
	});

	it("haelt Urlaub und Zeitausgleich auf derselben Zeile auseinander", () => {
		const totals = dayTotals([dayEntry("u", 0.5), dayEntry("z", 0.5, true)], ABSENCES, HPD);
		expect(totals.absent).toBe(3.75);
		expect(totals.timeOff).toBe(3.75);
		expect(totals.total).toBe(7.5);
	});

	it("zieht die Pause nur von der Projektzeit ab, nie vom freien Tag", () => {
		const totals = dayTotals([work("1", 8, 17)], ABSENCES, HPD, { deductBreaks: true });
		expect(totals.pause).toBeGreaterThan(0);
		expect(totals.total).toBe(totals.worked - totals.pause);
	});

	it("laesst einen Zeitausgleich keine Pause ausloesen", () => {
		// Ohne die Trennung schluege der Tagessatz als "gearbeitet" zu Buche und
		// zoege ab neun Stunden auch noch eine Pause nach sich.
		const totals = dayTotals([dayEntry("z", 1, true)], ABSENCES, HPD, { deductBreaks: true });
		expect(totals.pause).toBe(0);
		expect(totals.total).toBe(7.5);
	});
});
