import { describe, expect, it } from "vitest";
import { dayConflict } from "./conflicts";
import type { Entry } from "./types";

const ABS = "abs";
const DAY = Date.UTC(2026, 5, 10, 8, 0, 0);
const NEXT = DAY + 24 * 3600 * 1000;

function e(id: string, activityId: string, startTs: number, dayFraction?: number): Entry {
	const entry: Entry = { id, activityId, startTs, endTs: startTs, note: "", source: "manual" };
	if (dayFraction != null) entry.dayFraction = dayFraction;
	return entry;
}

describe("dayConflict", () => {
	it("erlaubt Projektzeit ohne Abwesenheit", () => {
		const entries = [e("1", "proj", DAY)];
		expect(dayConflict(entries, { activityId: "proj", startTs: DAY }, ABS)).toBeNull();
	});

	it("blockt Projektzeit an einem Ganztags-Abwesenheitstag", () => {
		const entries = [e("a", ABS, DAY, 1)];
		expect(dayConflict(entries, { activityId: "proj", startTs: DAY }, ABS)).toBe(
			"full-day-absence"
		);
	});

	it("blockt Ganztags-Abwesenheit an einem Tag mit Projektzeit", () => {
		const entries = [e("p", "proj", DAY)];
		expect(
			dayConflict(entries, { activityId: ABS, startTs: DAY, dayFraction: 1 }, ABS)
		).toBe("project-time");
	});

	it("erlaubt halben Urlaubstag neben Projektzeit", () => {
		const entries = [e("p", "proj", DAY)];
		expect(
			dayConflict(entries, { activityId: ABS, startTs: DAY, dayFraction: 0.5 }, ABS)
		).toBeNull();
	});

	it("erlaubt Projektzeit neben halbem Urlaubstag", () => {
		const entries = [e("h", ABS, DAY, 0.5)];
		expect(dayConflict(entries, { activityId: "proj", startTs: DAY }, ABS)).toBeNull();
	});

	it("ignoriert Konflikte an anderen Tagen", () => {
		const entries = [e("a", ABS, DAY, 1)];
		expect(dayConflict(entries, { activityId: "proj", startTs: NEXT }, ABS)).toBeNull();
	});

	it("zählt den bearbeiteten Eintrag selbst nicht (excludeId)", () => {
		// Eintrag wird zu Ganztags-Abwesenheit bearbeitet; ohne andere Einträge kein Konflikt.
		const entries = [e("x", ABS, DAY, 1)];
		expect(
			dayConflict(entries, { activityId: ABS, startTs: DAY, dayFraction: 1 }, ABS, {
				excludeId: "x"
			})
		).toBeNull();
	});

	it("behandelt fehlendes dayFraction als ganzen Tag", () => {
		const entries = [e("a", ABS, DAY)]; // kein dayFraction -> ganzer Tag
		expect(dayConflict(entries, { activityId: "proj", startTs: DAY }, ABS)).toBe(
			"full-day-absence"
		);
	});
});
