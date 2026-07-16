import { describe, expect, it } from "vitest";
import { planBackdate, planIsEmpty, planNeedsConfirm } from "./backdate";
import type { Entry } from "./types";

const ABS = "abs";
const ABSENCES = new Set([ABS]);
const H = 3600 * 1000;
const DAY = new Date(2026, 6, 17, 0, 0, 0).getTime();
const at = (h: number) => DAY + h * H;

function e(id: string, from: number, to: number | null, activityId = "p1"): Entry {
	return { id, activityId, startTs: at(from), endTs: to === null ? null : at(to), note: "", source: "timer" };
}

describe("planBackdate", () => {
	const NOW = at(10);

	it("laesst Zeiten vor dem Start unberuehrt", () => {
		const plan = planBackdate([e("a", 6, 8)], at(9), ABSENCES, NOW);
		expect(planIsEmpty(plan)).toBe(true);
	});

	it("laesst eine Zeit unberuehrt, die genau am Start endet", () => {
		expect(planIsEmpty(planBackdate([e("a", 6, 9)], at(9), ABSENCES, NOW))).toBe(true);
	});

	it("kuerzt eine angeschnittene Zeit auf den neuen Start", () => {
		// Joels Fall: 2 h drin, Timer mit -60 Min -> 1 h wird abgezogen.
		const plan = planBackdate([e("a", 8, 10)], at(9), ABSENCES, NOW);
		expect(plan.remove).toEqual([]);
		expect(plan.truncate).toHaveLength(1);
		expect(plan.truncate[0].entry.id).toBe("a");
		expect(plan.truncate[0].endTs).toBe(at(9));
	});

	it("entfernt eine vollstaendig ueberdeckte Zeit", () => {
		const plan = planBackdate([e("a", 9, 10)], at(8), ABSENCES, NOW);
		expect(plan.truncate).toEqual([]);
		expect(plan.remove.map((x) => x.id)).toEqual(["a"]);
	});

	it("kuerzt einen laufenden Eintrag statt ihn auf Laenge 0 zu stauchen", () => {
		const plan = planBackdate([e("r", 8, null)], at(9), ABSENCES, NOW);
		expect(plan.truncate[0].endTs).toBe(at(9));
	});

	it("entfernt einen laufenden Eintrag, der ganz im neuen Zeitraum liegt", () => {
		// Genau die Null-Sekunden-Eintraege, die vorher entstanden.
		const plan = planBackdate([e("r", 9, null)], at(8), ABSENCES, NOW);
		expect(plan.truncate).toEqual([]);
		expect(plan.remove.map((x) => x.id)).toEqual(["r"]);
	});

	it("fasst Abwesenheiten nicht an", () => {
		const abs: Entry = {
			id: "v",
			activityId: ABS,
			startTs: at(12),
			endTs: at(12),
			note: "",
			source: "manual",
			dayFraction: 1
		};
		expect(planIsEmpty(planBackdate([abs], at(8), ABSENCES, NOW))).toBe(true);
	});

	it("behandelt mehrere Eintraege in einem Rutsch", () => {
		const plan = planBackdate([e("a", 6, 8), e("b", 8, 10), e("c", 9, 10)], at(9), ABSENCES, NOW);
		expect(plan.truncate.map((t) => t.entry.id)).toEqual(["b"]);
		expect(plan.remove.map((x) => x.id)).toEqual(["c"]);
	});

	it("greift ueber Mitternacht", () => {
		// Kurz nach Mitternacht "vor 60 Min": trifft den Eintrag von gestern Abend.
		const gestern: Entry = {
			id: "g",
			activityId: "p1",
			startTs: DAY - 2 * H, // 22:00 Vortag
			endTs: DAY, // 00:00
			note: "",
			source: "timer"
		};
		const plan = planBackdate([gestern], DAY - H, ABSENCES, DAY + H);
		expect(plan.truncate[0].endTs).toBe(DAY - H);
	});
});

describe("planNeedsConfirm", () => {
	const NOW = at(10);

	it("fragt bei abgeschlossenen Zeiten", () => {
		expect(planNeedsConfirm(planBackdate([e("a", 8, 10)], at(9), ABSENCES, NOW))).toBe(true);
	});

	it("fragt NICHT beim normalen Wechsel eines laufenden Timers", () => {
		expect(planNeedsConfirm(planBackdate([e("r", 8, null)], at(9), ABSENCES, NOW))).toBe(false);
	});

	it("fragt nicht, wenn nichts betroffen ist", () => {
		expect(planNeedsConfirm(planBackdate([e("a", 6, 8)], at(9), ABSENCES, NOW))).toBe(false);
	});
});
