import { describe, expect, it } from "vitest";
import { buildReport, reportToHtml } from "./report";
import type { Activity, Entry } from "./types";

const HPD = 7.5;

const activities: Activity[] = [
	{ id: "a", name: "Projekt 1", sortOrder: 0, archived: false, isAbsence: false },
	{ id: "b", name: "Projekt 2", sortOrder: 1, archived: false, isAbsence: false },
	{ id: "old", name: "Altprojekt", sortOrder: 2, archived: true, isAbsence: false },
	{ id: "others", name: "Others", sortOrder: 3, archived: false, isAbsence: false },
	{ id: "abs", name: "Abwesenheiten", sortOrder: 4, archived: false, isAbsence: true }
];

const start = Date.UTC(2026, 5, 10, 8, 0, 0);

function work(id: string, activityId: string, seconds: number): Entry {
	return { id, activityId, startTs: start, endTs: start + seconds * 1000, note: "", source: "manual" };
}

const DAY = 24 * 3600 * 1000;
function absence(id: string, fraction: number, dayOffset = 0): Entry {
	const ts = start + dayOffset * DAY;
	return { id, activityId: "abs", startTs: ts, endTs: ts, note: "", source: "manual", dayFraction: fraction };
}

const entries: Entry[] = [
	work("1", "a", 7200), // 2.0 h
	work("2", "b", 4800), // 1.333 h -> 1.5
	work("4", "old", 3600), // archiviert -> nicht im Bericht
	absence("5", 1, 5), // ganzer Tag (anderer Tag, da Ganztags-Abwesenheit Projektzeit ausschließt) -> 7.5
	absence("6", 0.5) // halber Tag (darf neben Projektzeit liegen) -> 3.75
];

describe("buildReport", () => {
	const report = buildReport("2026-06", activities, entries, 0.5, HPD);

	it("erzeugt eine Zeile je nicht-archivierter Aktivität", () => {
		expect(report.rows.map((r) => r.name)).toEqual([
			"Projekt 1",
			"Projekt 2",
			"Others",
			"Abwesenheiten"
		]);
	});

	it("rundet Arbeitszeit, aber nicht die Tages-Abwesenheiten", () => {
		const hours = Object.fromEntries(report.rows.map((r) => [r.name, r.hours]));
		expect(hours["Projekt 1"]).toBe(2.0);
		expect(hours["Projekt 2"]).toBe(1.5);
		expect(hours["Others"]).toBe(0);
		expect(hours["Abwesenheiten"]).toBe(11.25); // 7.5 + 3.75, ungerundet
	});

	it("trennt Arbeitszeit und Abwesenheiten und summiert korrekt", () => {
		expect(report.workHours).toBe(3.5);
		expect(report.absenceHours).toBe(11.25);
		expect(report.total).toBe(14.75);
	});

	it("setzt das Monatslabel", () => {
		expect(report.label).toBe("Juni 2026");
	});

	it("ignoriert Projektzeiten an Ganztags-Abwesenheitstagen", () => {
		const sameDay: Entry[] = [
			work("w", "a", 7200), // 2 h am Starttag
			{ id: "fa", activityId: "abs", startTs: start, endTs: start, note: "", source: "manual", dayFraction: 1 }
		];
		const r = buildReport("2026-06", activities, sameDay, 0.5, HPD);
		const hours = Object.fromEntries(r.rows.map((row) => [row.name, row.hours]));
		expect(hours["Projekt 1"]).toBe(0); // Projektzeit faellt weg
		expect(hours["Abwesenheiten"]).toBe(7.5);
		expect(r.workHours).toBe(0);
	});
});

describe("reportToHtml", () => {
	const report = buildReport("2026-06", activities, entries, 0.5, HPD);
	const html = reportToHtml(report);

	it("enthält Kopf, Aktivitäten und Summe", () => {
		expect(html).toContain("Stunden");
		expect(html).toContain("Projekt 1");
		expect(html).toContain("Abwesenheiten");
		expect(html).toContain("Summe");
		expect(html).toContain("14,75");
	});

	it("escaped HTML-Sonderzeichen in Aktivitätsnamen", () => {
		const tricky: Activity[] = [
			{ id: "x", name: "A & B <Test>", sortOrder: 0, archived: false, isAbsence: false }
		];
		const r = buildReport("2026-06", tricky, [], 0.5, HPD);
		const h = reportToHtml(r);
		expect(h).toContain("A &amp; B &lt;Test&gt;");
	});
});
