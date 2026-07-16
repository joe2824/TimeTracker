import { describe, expect, it } from "vitest";
import { dayConflict, overlapConflict } from "./conflicts";
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

describe("overlapConflict", () => {
	const ABSENCES = new Set([ABS]);
	const H = 3600 * 1000;
	/** Projektzeit von Stunde `from` bis `to` am Testtag. */
	const span = (id: string, from: number, to: number | null): Entry => ({
		id,
		activityId: "p1",
		startTs: DAY + from * H,
		endTs: to === null ? null : DAY + to * H,
		note: "",
		source: "manual"
	});
	const cand = (from: number, to: number | null, activityId = "p2") => ({
		activityId,
		startTs: DAY + from * H,
		endTs: to === null ? null : DAY + to * H
	});

	it("meldet eine echte Ueberschneidung", () => {
		const hit = overlapConflict([span("a", 8, 12)], cand(10, 14), ABSENCES);
		expect(hit?.id).toBe("a");
	});

	it("laesst aneinander anstossende Zeiten zu", () => {
		// 08:00–12:00 und 12:00–14:00 ueberschneiden sich nicht.
		expect(overlapConflict([span("a", 8, 12)], cand(12, 14), ABSENCES)).toBeNull();
	});

	it("meldet vollstaendige Umschliessung in beide Richtungen", () => {
		expect(overlapConflict([span("a", 8, 18)], cand(10, 12), ABSENCES)?.id).toBe("a");
		expect(overlapConflict([span("a", 10, 12)], cand(8, 18), ABSENCES)?.id).toBe("a");
	});

	it("ignoriert den Eintrag, der gerade bearbeitet wird", () => {
		const existing = span("a", 8, 12);
		expect(overlapConflict([existing], cand(9, 11), ABSENCES, { excludeId: "a" })).toBeNull();
	});

	it("ignoriert Abwesenheiten – die haben keine Zeitspanne", () => {
		const abs: Entry = {
			id: "v",
			activityId: ABS,
			startTs: DAY + 4 * H,
			endTs: DAY + 4 * H,
			note: "",
			source: "manual",
			dayFraction: 1
		};
		expect(overlapConflict([abs], cand(8, 12), ABSENCES)).toBeNull();
	});

	it("prueft eine Abwesenheit selbst nicht auf Ueberschneidung", () => {
		expect(overlapConflict([span("a", 8, 12)], cand(8, 12, ABS), ABSENCES)).toBeNull();
	});

	it("rechnet einen laufenden Eintrag bis now", () => {
		const running = span("r", 8, null);
		const now = DAY + 12 * H;
		expect(overlapConflict([running], cand(10, 11), ABSENCES, { now })?.id).toBe("r");
		// nach `now` ist die Bahn frei
		expect(overlapConflict([running], cand(13, 14), ABSENCES, { now })).toBeNull();
	});

	it("prueft einen laufenden Kandidaten nicht – sein Ende steht noch nicht fest", () => {
		expect(overlapConflict([span("a", 8, 12)], cand(10, null), ABSENCES)).toBeNull();
	});

	it("laesst Zeiten an verschiedenen Tagen zu", () => {
		const morgen = { activityId: "p2", startTs: NEXT + 8 * H, endTs: NEXT + 12 * H };
		expect(overlapConflict([span("a", 8, 12)], morgen, ABSENCES)).toBeNull();
	});
});
