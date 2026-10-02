import { describe, expect, it } from "vitest";
import type { Entry } from "../types";
import { continuationStart } from "./entryPrefill";
import { wallToTs } from "./tz";

const ABSENCES = new Set(["abs"]);
const DATE = "2026-06-10";

// Wanduhrzeit in der Zone des Kontos, nicht Date.UTC: die Funktion ordnet über
// fmtDate nach dem Tag dort ein.
const at = (hour: number, minute = 0, second = 0, day = 10) =>
	wallToTs(2026, 6, day, hour, minute, second);

function span(id: string, startTs: number, endTs: number | null, activityId = "proj"): Entry {
	return { id, activityId, startTs, endTs, note: "", source: "manual" };
}

describe("continuationStart", () => {
	it("kennt an einem leeren Tag keinen Anschluss", () => {
		expect(continuationStart([], DATE, ABSENCES)).toBeNull();
	});

	it("liefert das Ende des einzigen Eintrags", () => {
		expect(continuationStart([span("a", at(9), at(10, 30))], DATE, ABSENCES)).toBe(at(10, 30));
	});

	it("gibt die Sekunden eines Timer-Eintrags unverändert zurück", () => {
		const end = at(14, 0, 22);
		expect(continuationStart([span("a", at(13), end)], DATE, ABSENCES)).toBe(end);
	});

	it("nimmt das späteste Ende, auch wenn Einträge nicht aneinander anschliessen", () => {
		const entries = [span("b", at(13), at(14)), span("a", at(8), at(9))];
		expect(continuationStart(entries, DATE, ABSENCES)).toBe(at(14));
	});

	it("nimmt bei verschachtelten Einträgen das späteste Ende, nicht den spätesten Beginn", () => {
		const entries = [span("outer", at(9), at(17)), span("inner", at(10), at(11))];
		expect(continuationStart(entries, DATE, ABSENCES)).toBe(at(17));
	});

	it("lässt Abwesenheiten aus, auch wenn sie am spätesten liegen", () => {
		const entries = [span("a", at(8), at(9)), span("abs", at(12), at(12), "abs")];
		expect(continuationStart(entries, DATE, ABSENCES)).toBe(at(9));
	});

	it("lässt einen laufenden Timer aus", () => {
		const entries = [span("a", at(9), at(12)), span("run", at(12), null)];
		expect(continuationStart(entries, DATE, ABSENCES)).toBe(at(12));
		expect(continuationStart([span("run", at(12), null)], DATE, ABSENCES)).toBeNull();
	});

	it("lässt ein Ende genau um Mitternacht aus und nimmt das Ende davor", () => {
		const midnight = at(0, 0, 0, 11);
		const entries = [span("a", at(9), at(12)), span("late", at(22), midnight)];
		expect(continuationStart(entries, DATE, ABSENCES)).toBe(at(12));
	});

	it("lässt einen Eintrag aus, der erst am Folgetag endet", () => {
		const entries = [span("night", at(23), at(1, 0, 0, 11))];
		expect(continuationStart(entries, DATE, ABSENCES)).toBeNull();
	});

	it("lässt einen Eintrag vom Vortag aus, der in den Tag hineinreicht", () => {
		const entries = [span("night", at(23, 0, 0, 9), at(1))];
		expect(continuationStart(entries, DATE, ABSENCES)).toBeNull();
	});

	it("beachtet nur Einträge des gefragten Tages", () => {
		const entries = [span("a", at(9), at(10)), span("other", at(15, 0, 0, 11), at(16, 0, 0, 11))];
		expect(continuationStart(entries, DATE, ABSENCES)).toBe(at(10));
		expect(continuationStart(entries, "2026-06-12", ABSENCES)).toBeNull();
	});
});
