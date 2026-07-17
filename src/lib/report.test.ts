import { describe, expect, it } from "vitest";
import { buildReport, reportSubject, reportToHtml } from "./report";
import type { Activity, Entry } from "./types";

const HPD = 7.5;

const activities: Activity[] = [
	{ id: "a", name: "Projekt 1", sortOrder: 0, archived: false, isAbsence: false },
	{ id: "b", name: "Projekt 2", sortOrder: 1, archived: false, isAbsence: false },
	{ id: "old", name: "Altprojekt", sortOrder: 2, archived: true, isAbsence: false },
	{ id: "others", name: "Others", sortOrder: 3, archived: false, isAbsence: false },
	{ id: "abs", name: "Abwesenheiten", sortOrder: 4, archived: false, isAbsence: true }
];

// Lokalzeit, nicht Date.UTC: buildReport gruppiert ueber fmtDate und prueft
// Werktage ueber getDay() – beides lokal. Mit UTC-Zeitstempeln entschiede die
// Zone des Rechners, auf welchen Tag (und Wochentag) ein Eintrag faellt.
const start = new Date(2026, 5, 10, 8, 0, 0).getTime();

function work(id: string, activityId: string, seconds: number): Entry {
	return { id, activityId, startTs: start, endTs: start + seconds * 1000, note: "", source: "manual" };
}

/** Tagesversatz ueber den Kalender, nicht ueber +24h – siehe allDayNoons. */
function absence(id: string, fraction: number, dayOffset = 0): Entry {
	const ts = new Date(2026, 5, 10 + dayOffset, 12, 0, 0).getTime();
	return { id, activityId: "abs", startTs: ts, endTs: ts, note: "", source: "manual", dayFraction: fraction };
}

const entries: Entry[] = [
	work("1", "a", 7200), // 2.0 h
	work("2", "b", 4800), // 1.333 h -> 1.5
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


	it("klammert Abwesenheiten an Nicht-Arbeitstagen aus (workdays Mo–Fr)", () => {
		const fri = new Date(2026, 6, 10, 12, 0, 0).getTime(); // Freitag
		const sat = new Date(2026, 6, 11, 12, 0, 0).getTime(); // Samstag
		const es: Entry[] = [
			{ id: "f", activityId: "abs", startTs: fri, endTs: fri, note: "", source: "manual", dayFraction: 1 },
			{ id: "s", activityId: "abs", startTs: sat, endTs: sat, note: "", source: "manual", dayFraction: 1 }
		];
		const withFilter = buildReport("2026-07", activities, es, 0.5, HPD, [1, 2, 3, 4, 5]);
		const h1 = Object.fromEntries(withFilter.rows.map((r) => [r.name, r.hours]));
		expect(h1["Abwesenheiten"]).toBe(7.5); // nur Freitag zählt

		const noFilter = buildReport("2026-07", activities, es, 0.5, HPD);
		const h2 = Object.fromEntries(noFilter.rows.map((r) => [r.name, r.hours]));
		expect(h2["Abwesenheiten"]).toBe(15); // ohne Filter beide Tage
	});

	it("behält Stunden archivierter Aktivitäten im Bericht", () => {
		const archived: Activity[] = [
			...activities,
			{ id: "arch", name: "Altprojekt X", sortOrder: 5, archived: true, isAbsence: false }
		];
		// Mit Stunden -> Zeile erscheint trotz archiviert.
		const withHours = buildReport("2026-06", archived, [work("z", "arch", 3600)], 0.5, HPD);
		expect(withHours.rows.map((r) => r.name)).toContain("Altprojekt X");
		expect(withHours.workHours).toBe(1.0);
		// Ohne Stunden -> archivierte Zeile bleibt aus (kein Ballast).
		const noHours = buildReport("2026-06", archived, [], 0.5, HPD);
		expect(noHours.rows.map((r) => r.name)).not.toContain("Altprojekt X");
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
		expect(html).toContain("14:45"); // 14,75 h als Zeit
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

describe("reportSubject", () => {
	it("ersetzt beide Platzhalter", () => {
		expect(reportSubject("Stundenerfassung {month} – {name}", "Juli 2026", "Joel Klein")).toBe(
			"Stundenerfassung Juli 2026 – Joel Klein"
		);
	});

	it("haengt den Namen an, wenn die Vorlage {name} nicht enthaelt", () => {
		// Genau der Fall: Platzhalter beim Bearbeiten der Vorlage verloren,
		// Name steht aber in den Einstellungen.
		expect(reportSubject("Stundenerfassung {month}", "Juli 2026", "Joel Klein")).toBe(
			"Stundenerfassung Juli 2026 – Joel Klein"
		);
	});

	it("haengt nichts an, wenn kein Name hinterlegt ist", () => {
		expect(reportSubject("Stundenerfassung {month}", "Juli 2026", "")).toBe(
			"Stundenerfassung Juli 2026"
		);
	});

	it("laesst ohne Namen keinen leeren Trenner stehen", () => {
		expect(reportSubject("Stundenerfassung {month} – {name}", "Juli 2026", "  ")).toBe(
			"Stundenerfassung Juli 2026"
		);
	});

	it("faellt bei leerer Vorlage auf den Standard zurueck", () => {
		expect(reportSubject("", "Juli 2026", "Joel")).toBe("Stundenerfassung Juli 2026 – Joel");
	});

	it("dupliziert den Namen nicht, wenn {name} schon vorkommt", () => {
		expect(reportSubject("{name}: Stunden {month}", "Juli 2026", "Joel")).toBe(
			"Joel: Stunden Juli 2026"
		);
	});
});

describe("buildReport – offene Einträge", () => {
	const P1: Activity = {
		id: "p1",
		name: "Projekt 1",
		sortOrder: 0,
		archived: false,
		isAbsence: false
	};
	/** Feste Uhr: 17.07.2026, 08:30 – sonst prüfte der Test die Wanduhr. */
	const NOW = new Date(2026, 6, 17, 8, 30, 0).getTime();
	const offen = (start: number): Entry => ({
		id: "x",
		activityId: "p1",
		startTs: start,
		endTs: null,
		note: "",
		source: "timer"
	});

	it("kappt einen vergessenen offenen Eintrag am Ende SEINES Tages", () => {
		// Vorher zählte der bis Date.now(): ein offener Eintrag vom 1. Juni meldete
		// über 1000 h – und die gingen so an die Vorgesetzten.
		const r = buildReport(
			"2026-06",
			[P1],
			[offen(new Date(2026, 5, 1, 8, 0, 0).getTime())],
			0.5,
			7.5,
			[1, 2, 3, 4, 5],
			NOW
		);
		expect(r.workHours).toBe(16); // 08:00 bis Mitternacht
	});

	it("rechnet einen HEUTE laufenden Timer bis jetzt", () => {
		const r = buildReport(
			"2026-07",
			[P1],
			[offen(new Date(2026, 6, 17, 6, 30, 0).getTime())],
			0.5,
			7.5,
			[1, 2, 3, 4, 5],
			NOW
		);
		expect(r.workHours).toBe(2); // 06:30 -> 08:30
	});

	it("bleibt auch ohne now-Argument begrenzt", () => {
		const r = buildReport(
			"2026-06",
			[P1],
			[offen(new Date(2026, 5, 1, 8, 0, 0).getTime())],
			0.5,
			7.5,
			[1, 2, 3, 4, 5]
		);
		expect(r.workHours).toBeLessThanOrEqual(24);
	});
});
