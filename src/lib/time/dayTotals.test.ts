import { describe, expect, it } from "vitest";
import { dayTotals } from "./dayTotals";
import type { Activity, Entry } from "../types";
import { wallToTs } from "./tz";
import { fmtDate } from "./time";
import { buildReport } from "../report/report";

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
		// Ein Urlaubstag füllt das Tagessoll - er ist kein Minus.
		expect(dayTotals([dayEntry("u", 1)], ABSENCES, HPD).total).toBe(7.5);
	});

	it("zaehlt einen ganzen Tag Zeitausgleich wie eine Abwesenheit", () => {
		// Er füllt das Tagessoll wie ein Urlaubstag - getrennt geführt wird er nur,
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
		// Der übliche Fall: vormittags arbeiten, nachmittags abfeiern.
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
		// Ohne die Trennung schlüge der Tagessatz als "gearbeitet" zu Buche und
		// zöge ab neun Stunden auch noch eine Pause nach sich.
		const totals = dayTotals([dayEntry("z", 1, true)], ABSENCES, HPD, { deductBreaks: true });
		expect(totals.pause).toBe(0);
		expect(totals.total).toBe(7.5);
	});

	// Ein vergessener Timer zählt nur bis zum Ende SEINES Tages – wie in Bericht,
	// Auswertung, Abgleich und Arbeitszeit-Check. Sonst stünden am Starttag
	// 40 Stunden, während der Bericht 16 kennt.
	it("kappt einen offenen Eintrag am Ende seines Tages", () => {
		const open: Entry = { ...work("1", 8, 9), endTs: null };
		const twoDaysLater = wallToTs(2026, 9, 3, 12, 0, 0);
		const totals = dayTotals([open], ABSENCES, HPD, { now: twoDaysLater });
		expect(totals.worked).toBe(16);
	});

	it("zaehlt einen offenen Eintrag von heute bis jetzt", () => {
		const open: Entry = { ...work("1", 8, 9), endTs: null };
		expect(dayTotals([open], ABSENCES, HPD, { now: at(10, 30) }).worked).toBe(2.5);
	});

	describe("mit Arbeitstagen – dieselben Regeln wie buildReport", () => {
		const MON_FRI = [1, 2, 3, 4, 5];
		const saturday = (e: Entry): Entry => {
			const shift = wallToTs(2026, 9, 5, 12, 0, 0) - at(12);
			return { ...e, startTs: e.startTs + shift, endTs: e.endTs === null ? null : e.endTs + shift };
		};

		it("zaehlt eine Abwesenheit am freien Tag nicht", () => {
			const totals = dayTotals([saturday(dayEntry("u", 1))], ABSENCES, HPD, { workdays: MON_FRI });
			expect(totals.absent).toBe(0);
			expect(totals.total).toBe(0);
		});

		it("zaehlt Projektzeit am freien Tag weiterhin", () => {
			const totals = dayTotals([saturday(work("1", 8, 12))], ABSENCES, HPD, { workdays: MON_FRI });
			expect(totals.total).toBe(4);
		});

		it("zaehlt Projektzeit neben einer Ganztags-Abwesenheit nicht", () => {
			const totals = dayTotals([work("1", 8, 12), dayEntry("u", 1)], ABSENCES, HPD, {
				workdays: MON_FRI
			});
			expect(totals.worked).toBe(0);
			expect(totals.total).toBe(7.5);
		});

		it("laesst Projektzeit neben einem halben Tag stehen", () => {
			const totals = dayTotals([work("1", 8, 12), dayEntry("u", 0.5)], ABSENCES, HPD, {
				workdays: MON_FRI
			});
			expect(totals.total).toBe(7.75);
		});

		it("stimmt mit buildReport ueberein", () => {
			const entries = [work("1", 8, 17), dayEntry("u", 0.5), saturday(dayEntry("z", 1, true))];
			const activities: Activity[] = [
				{ id: "p1", name: "P", sortOrder: 0, archived: false, isAbsence: false },
				{ id: ABS, name: "A", sortOrder: 1, archived: false, isAbsence: true }
			];
			const report = buildReport("2026-09", activities, entries, 0, HPD, MON_FRI, at(20), true);
			const byDay = new Map<string, Entry[]>();
			for (const e of entries) {
				const d = fmtDate(e.startTs);
				byDay.set(d, [...(byDay.get(d) ?? []), e]);
			}
			let sum = 0;
			for (const list of byDay.values()) {
				sum += dayTotals(list, ABSENCES, HPD, { now: at(20), deductBreaks: true, workdays: MON_FRI })
					.total;
			}
			expect(sum).toBeCloseTo(report.total, 9);
		});
	});
});
