import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
	breakHours,
	grossHours,
	hasStamps,
	parseReportClock,
	parseReportDate,
	parseReportHours,
	parseTimeReport,
	ruleBreakHours,
	serialToDate,
	TimeReportError,
	type TimeReportDay
} from "./timeReport";
import { readXlsx, type XlsxSheet } from "./xlsx";

const HEADER = [
	"Personalnummer",
	"Nachname",
	"Vorname",
	"Tag",
	"Erstes kommen",
	"Letztes gehen",
	"Verstoß Ruhepause",
	"Arbeitszeit täglich",
	"Arbeitszeit täglich > 10h",
	"Soll Arbeitszeit > 10h",
	"Wiedereingliederung",
	"Arbeit am Sonntag",
	"Arbeit am Feiertag",
	"Vorgesetzter"
];

/** Ein Blatt aus Kopfzeile + Datenzeilen bauen, ohne den Umweg ueber ZIP. */
function sheet(rows: string[][], name = "Ergebnisse"): XlsxSheet {
	return { name, rows: [HEADER, ...rows] };
}

/** Datenzeile: Personalnr., Name, Vorname, Serial, kommen, gehen, Stunden. */
function row(
	serial: string,
	kommen: string,
	gehen: string,
	stunden: string,
	person: [string, string, string] = ["00123456", "Meier", "Anna"]
): string[] {
	return [...person, serial, kommen, gehen, "", stunden, "", "", "", "", "", ""];
}

describe("serialToDate", () => {
	it("rechnet die Excel-Serienzahl in ein Kalenderdatum um", () => {
		// 46023 ist im echten Report der 01.01.2026.
		expect(serialToDate(46023)).toBe("2026-01-01");
		expect(serialToDate(46053)).toBe("2026-01-31");
		expect(serialToDate(46054)).toBe("2026-02-01");
		// Schaltjahr: den 29.02.2028 gibt es wirklich.
		expect(serialToDate(46811)).toBe("2028-02-28");
		expect(serialToDate(46812)).toBe("2028-02-29");
		expect(serialToDate(46813)).toBe("2028-03-01");
	});

	it("beruecksichtigt Excels erfundenen 29.02.1900 nicht doppelt", () => {
		expect(serialToDate(61)).toBe("1900-03-01");
	});

	it("liefert null fuer Unsinn", () => {
		expect(serialToDate(0)).toBeNull();
		expect(serialToDate(NaN)).toBeNull();
	});
});

describe("parseReportDate", () => {
	it("liest Serienzahl, ISO und deutsches Datum", () => {
		expect(parseReportDate("46023.0")).toBe("2026-01-01");
		expect(parseReportDate("46023")).toBe("2026-01-01");
		expect(parseReportDate("2026-01-01")).toBe("2026-01-01");
		expect(parseReportDate("2026-01-01T00:00:00")).toBe("2026-01-01");
		expect(parseReportDate("1.1.2026")).toBe("2026-01-01");
		expect(parseReportDate("31.12.2026")).toBe("2026-12-31");
	});

	it("liefert null fuer Leeres und Text", () => {
		expect(parseReportDate("")).toBeNull();
		expect(parseReportDate("  ")).toBeNull();
		expect(parseReportDate("Summe")).toBeNull();
	});
});

describe("parseReportClock", () => {
	it("liest Uhrzeittext", () => {
		expect(parseReportClock("09:10")).toBe("09:10");
		expect(parseReportClock("9:10")).toBe("09:10");
		expect(parseReportClock("17:35:00")).toBe("17:35");
	});

	it("liest den Excel-Tagesbruch", () => {
		// 09:10 = 550/1440
		expect(parseReportClock("0.3819444444")).toBe("09:10");
		expect(parseReportClock("0,5")).toBe("12:00");
	});

	it("liefert null fuer Leeres und Unzulaessiges", () => {
		expect(parseReportClock("")).toBeNull();
		expect(parseReportClock("25:00")).toBeNull();
		expect(parseReportClock("09:60")).toBeNull();
	});

	it("liest die numerische 0 als nicht-gestempelt, nicht als Mitternacht", () => {
		// Sonst bekaeme ein Urlaubstag ein Anwesenheitsfenster ab 00:00, und der
		// Nachtrag schluege Projektzeit mitten in der Nacht vor.
		expect(parseReportClock("0")).toBeNull();
		expect(parseReportClock("0.0")).toBeNull();
		expect(parseReportClock("0,00")).toBeNull();
	});
});

describe("parseReportHours", () => {
	it("liest Dezimalstunden mit Punkt und Komma", () => {
		expect(parseReportHours("7.67")).toBeCloseTo(7.67);
		expect(parseReportHours("7,67")).toBeCloseTo(7.67);
		expect(parseReportHours("0.0")).toBe(0);
	});

	it("liest eine als Uhrzeit formatierte Spalte", () => {
		expect(parseReportHours("7:30")).toBeCloseTo(7.5);
	});

	it("liefert 0 fuer Leeres und Text", () => {
		expect(parseReportHours("")).toBe(0);
		expect(parseReportHours("—")).toBe(0);
	});
});

describe("Pause", () => {
	const day = (firstIn: string | null, lastOut: string | null, hours: number): TimeReportDay => ({
		date: "2026-01-12",
		firstIn,
		lastOut,
		hours,
		flags: []
	});

	it("kennt die Hausregel: ab 4 h 15 min, ab 6 h 45 min", () => {
		expect(ruleBreakHours(3)).toBe(0);
		expect(ruleBreakHours(4)).toBe(0);
		expect(ruleBreakHours(4.5)).toBe(0.25);
		expect(ruleBreakHours(6)).toBe(0.25);
		expect(ruleBreakHours(8)).toBe(0.75);
	});

	it("rechnet die Anwesenheit aus den Stempeln", () => {
		expect(grossHours(day("08:36", "16:49", 7.47))).toBeCloseTo(8.2167, 3);
		expect(grossHours(day(null, null, 7.5))).toBe(0);
		// Ueber Mitternacht gestempelt.
		expect(grossHours(day("22:00", "02:00", 3.25))).toBeCloseTo(4);
	});

	it("liest die tatsaechliche Pause aus Brutto minus Netto", () => {
		// Echte Zeilen aus dem Report: 45 min bzw. 15 min Abzug.
		expect(breakHours(day("08:36", "16:49", 7.47))).toBeCloseTo(0.7467, 3);
		expect(breakHours(day("08:25", "14:24", 5.73))).toBeCloseTo(0.2533, 3);
		// Zusaetzlich gestempelte Pause – mehr als jede Regel vorhersagt.
		expect(breakHours(day("08:47", "18:18", 8.27))).toBeCloseTo(1.25, 2);
	});

	it("faellt ohne Stempel auf die Regel zurueck", () => {
		expect(breakHours(day(null, null, 7.5))).toBe(0);
		// Nur ein Stempel reicht nicht fuer eine Messung.
		expect(breakHours(day("08:00", null, 7.5))).toBe(0);
	});

	it("nimmt die Regel, wenn die Messung nichts hergibt", () => {
		// Netto >= Brutto (Korrekturbuchung): gemessen waere die Pause 0 oder negativ.
		expect(breakHours(day("08:00", "16:00", 8))).toBe(0.75);
	});

	it("erkennt gestempelte Tage", () => {
		expect(hasStamps(day("08:00", "16:00", 7.5))).toBe(true);
		expect(hasStamps(day(null, null, 7.5))).toBe(false);
		expect(hasStamps(day("08:00", null, 7.5))).toBe(false);
	});
});

describe("parseTimeReport", () => {
	it("ordnet die Spalten ueber die Kopfzeile zu", () => {
		const report = parseTimeReport(sheet([row("46034.0", "09:10", "17:35", "7.67")]));
		expect(report.people).toHaveLength(1);
		expect(report.people[0]).toMatchObject({
			key: "00123456",
			personnelNo: "00123456",
			name: "Anna Meier"
		});
		expect(report.people[0].days[0]).toMatchObject({
			date: "2026-01-12",
			firstIn: "09:10",
			lastOut: "17:35",
			hours: 7.67
		});
	});

	it('verwechselt "Arbeitszeit täglich" nicht mit "Arbeitszeit täglich > 10h"', () => {
		// Die Ueberschriften beginnen gleich – ein Praefix-Vergleich laege hier falsch.
		const r = row("46062.0", "06:30", "18:00", "10.0");
		r[8] = "1,5"; // Arbeitszeit täglich > 10h
		const day = parseTimeReport(sheet([r])).people[0].days[0];
		expect(day.hours).toBe(10);
		expect(day.flags).toEqual([{ key: "ueber10", label: "> 10 h", value: "1,5" }]);
	});

	it("sammelt alle gesetzten Verstoss-Hinweise", () => {
		const r = row("46026.0", "08:00", "16:00", "7.5");
		r[6] = "X"; // Verstoß Ruhepause
		r[11] = "X"; // Arbeit am Sonntag
		const day = parseTimeReport(sheet([r])).people[0].days[0];
		expect(day.flags.map((f) => f.key)).toEqual(["ruhepause", "sonntag"]);
		expect(day.flags.map((f) => f.label)).toEqual(["Ruhepause", "Sonntag"]);
	});

	it("uebergeht Leerzeilen und Fusszeilen ohne Datum", () => {
		const report = parseTimeReport(
			sheet([
				row("46034.0", "09:10", "17:35", "7.67"),
				[],
				["", "", "", "Summe", "", "", "", "153.4"]
			])
		);
		expect(report.people[0].days).toHaveLength(1);
	});

	it("findet die Kopfzeile auch unter einem Vorspann", () => {
		const s = sheet([row("46034.0", "09:10", "17:35", "7.67")]);
		s.rows.unshift(["Zeitwirtschaftsreport"], [], ["Zeitraum: 01.01.2026 – 31.08.2026"]);
		expect(parseTimeReport(s).people[0].days).toHaveLength(1);
	});

	it("trennt mehrere Personen und sortiert sie nach Namen", () => {
		const report = parseTimeReport(
			sheet([
				row("00100002", "08:00", "16:00", "7.5", ["00100002", "Zeidler", "Anna"]),
				row("00100001", "08:00", "16:00", "7.5", ["00100001", "Beispiel", "Max"])
			])
		);
		expect(report.people.map((p) => p.name)).toEqual(["Anna Zeidler", "Max Beispiel"]);
	});

	it("fasst zwei Zeilen fuer denselben Tag zusammen", () => {
		const report = parseTimeReport(
			sheet([row("46034.0", "09:10", "12:00", "2.8"), row("46034.0", "13:00", "17:35", "4.5")])
		);
		const days = report.people[0].days;
		expect(days).toHaveLength(1);
		expect(days[0]).toMatchObject({ firstIn: "09:10", lastOut: "17:35" });
		expect(days[0].hours).toBeCloseTo(7.3);
	});

	it("sortiert die Tage aufsteigend und listet die Monate", () => {
		const report = parseTimeReport(
			sheet([
				row("46054.0", "08:00", "16:00", "7.5"),
				row("46023.0", "", "", "7.5"),
				row("46035.0", "08:00", "16:00", "7.5")
			])
		);
		expect(report.people[0].days.map((d) => d.date)).toEqual([
			"2026-01-01",
			"2026-01-13",
			"2026-02-01"
		]);
		expect(report.months).toEqual(["2026-01", "2026-02"]);
	});

	it("meldet eine Datei ohne passende Kopfzeile", () => {
		expect(() => parseTimeReport({ name: "x", rows: [["Datum", "Projekt"], ["a", "b"]] })).toThrow(
			TimeReportError
		);
	});

	it("meldet eine Datei ohne Tageszeilen", () => {
		expect(() => parseTimeReport(sheet([]))).toThrow(/keine auswertbaren Tageszeilen/);
	});
});

describe("echter Report (anonymisiertes Fixture)", () => {
	async function load() {
		const url = new URL("./testing/zeitwirtschaftsreport.fixture.xlsx", import.meta.url);
		return parseTimeReport(await readXlsx(readFileSync(url)));
	}

	it("liest die Datei so, wie LOGA sie ausgibt", async () => {
		const report = await load();
		expect(report.people.map((p) => p.name)).toEqual(["Erika Muster", "Max Beispiel"]);
		expect(report.months).toEqual(["2026-01", "2026-02"]);

		const erika = report.people[0];
		expect(erika.personnelNo).toBe("00100001");
		expect(erika.days).toHaveLength(59); // 01.01. bis 28.02.2026
		expect(erika.days[0].date).toBe("2026-01-01");
		expect(erika.days.at(-1)!.date).toBe("2026-02-28");
	});

	it("unterscheidet Arbeitstage, freie Tage und Abwesenheiten", async () => {
		const days = (await load()).people[0].days;
		const gestempelt = days.filter(hasStamps);
		const abwesend = days.filter((d) => !hasStamps(d) && d.hours > 0);
		const frei = days.filter((d) => d.hours === 0);

		expect(gestempelt.length + abwesend.length + frei.length).toBe(days.length);
		// Kein Werktag faellt durchs Raster: freie Tage sind ausschliesslich Wochenenden.
		for (const d of frei) {
			const wd = new Date(`${d.date}T12:00:00Z`).getUTCDay();
			expect([0, 6]).toContain(wd);
		}
		// Abwesenheiten stehen im Report immer mit dem vollen Tagessatz.
		for (const d of abwesend) expect(d.hours).toBe(7.5);
		// 01.01. ist Neujahr, also ohne Stempel.
		expect(days[0]).toMatchObject({ firstIn: null, lastOut: null, hours: 7.5 });
	});

	it("liest die Verstoss-Spalten aus der echten Struktur", async () => {
		const report = await load();
		const erika = report.people[0];
		expect(erika.days.find((d) => d.date === "2026-01-13")!.flags.map((f) => f.key)).toEqual([
			"ruhepause"
		]);
		expect(erika.days.find((d) => d.date === "2026-01-22")!.flags).toEqual([
			{ key: "ueber10", label: "> 10 h", value: "0,95" }
		]);
		// Zweite Person: Sonntagsarbeit am 04.01.
		const max = report.people[1];
		expect(max.days.find((d) => d.date === "2026-01-04")!.flags.map((f) => f.key)).toEqual([
			"sonntag"
		]);
	});
});
