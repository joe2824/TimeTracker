import { describe, expect, it } from "vitest";
import {
	allDayNoons,
	clockToMin,
	durationHours,
	durationSeconds,
	entryHours,
	fmtDate,
	fmtDateHuman,
	fmtHMS,
	fmtHours,
	fmtHoursClock,
	isWorkday,
	minToClock,
	monthLabel,
	noonTs,
	parseClock,
	parseHours,
	roundHours,
	midnightSplitHint,
	splitAtMidnight,
	startOfNextDay,
	stepDate,
	toTs
} from "./time";

describe("stepDate", () => {
	it("rollt über Monats- und Jahresgrenzen", () => {
		expect(stepDate("2026-07-01", -1)).toBe("2026-06-30");
		expect(stepDate("2026-06-30", 1)).toBe("2026-07-01");
		expect(stepDate("2026-01-01", -1)).toBe("2025-12-31");
		expect(stepDate("2026-12-31", 1)).toBe("2027-01-01");
	});
	it("beachtet Schaltjahre (2028)", () => {
		expect(stepDate("2028-02-28", 1)).toBe("2028-02-29");
		expect(stepDate("2028-03-01", -1)).toBe("2028-02-29");
	});
	it("gibt bei ungültiger Eingabe unverändert zurück", () => {
		expect(stepDate("", 1)).toBe("");
	});
});

describe("isWorkday", () => {
	const MON_FRI = [1, 2, 3, 4, 5];
	it("Mo–Fr sind bei Standard-Arbeitstagen wahr, Sa/So falsch", () => {
		const mon = new Date(2026, 6, 6).getTime(); // Montag
		const sat = new Date(2026, 6, 11).getTime(); // Samstag
		const sun = new Date(2026, 6, 12).getTime(); // Sonntag
		expect(isWorkday(mon, MON_FRI)).toBe(true);
		expect(isWorkday(sat, MON_FRI)).toBe(false);
		expect(isWorkday(sun, MON_FRI)).toBe(false);
	});
	it("respektiert eine abweichende Arbeitswoche (z. B. inkl. Samstag)", () => {
		const sat = new Date(2026, 6, 11).getTime();
		expect(isWorkday(sat, [1, 2, 3, 4, 5, 6])).toBe(true);
	});
});

describe("allDayNoons", () => {
	// Outlook: Ganztags-Ende ist exklusiv (nächster Tag 00:00).
	it("einzelner Ganztags-Termin -> genau der Starttag", () => {
		const start = new Date(2026, 6, 8, 0, 0, 0).getTime(); // Mi 08.07.
		const end = new Date(2026, 6, 9, 0, 0, 0).getTime(); // Do 09.07. 00:00 (exklusiv)
		const days = allDayNoons(start, end);
		expect(days.map(fmtDate)).toEqual(["2026-07-08"]);
	});

	it("mehrtägiger Ganztags-Termin -> jeder Tag im Bereich", () => {
		const start = new Date(2026, 6, 8, 0, 0, 0).getTime(); // Mi 08.07.
		const end = new Date(2026, 6, 11, 0, 0, 0).getTime(); // Sa 11.07. 00:00 (exklusiv)
		const days = allDayNoons(start, end);
		expect(days.map(fmtDate)).toEqual(["2026-07-08", "2026-07-09", "2026-07-10"]);
	});

	it("Ende <= Start -> Fallback auf den Starttag", () => {
		const start = new Date(2026, 6, 8, 0, 0, 0).getTime();
		expect(allDayNoons(start, start).map(fmtDate)).toEqual(["2026-07-08"]);
	});

	// Ueber BEIDE Umstellungen: der 25.10.2026 hat 25 Stunden, der 29.03.2026 nur 23.
	// Wer hier mit +24h rechnet statt mit setDate(+1), landet auf 11:00 bzw. 13:00 und
	// schiebt die Tage danach ueber Mitternacht in den falschen Tag.
	it.each([
		["Winterzeit-Umstellung", new Date(2026, 9, 23), new Date(2026, 9, 28)],
		["Sommerzeit-Umstellung", new Date(2026, 2, 27), new Date(2026, 3, 1)]
	])("alle Zeitstempel liegen auf 12:00 (%s)", (_name, from, to) => {
		const noons = allDayNoons(from.getTime(), to.getTime());
		expect(noons.length).toBeGreaterThan(2); // sonst prueft die Schleife nichts
		for (const ts of noons) expect(new Date(ts).getHours()).toBe(12);
	});
});
import type { Entry } from "./types";

describe("roundHours", () => {
	it("rundet auf halbe Stunden", () => {
		expect(roundHours(2.0, 0.5)).toBe(2.0);
		expect(roundHours(2.2, 0.5)).toBe(2.0);
		expect(roundHours(2.3, 0.5)).toBe(2.5);
		expect(roundHours(1.333, 0.5)).toBe(1.5);
	});

	it("rundet auf Viertelstunden", () => {
		expect(roundHours(2.74, 0.25)).toBe(2.75);
		expect(roundHours(2.6, 0.25)).toBe(2.5);
	});

	it("rundet auf volle Stunden", () => {
		expect(roundHours(2.4, 1)).toBe(2);
		expect(roundHours(2.5, 1)).toBe(3);
	});

	it("lässt bei step<=0 unverändert", () => {
		expect(roundHours(1.23, 0)).toBe(1.23);
	});
});

describe("fmtHMS", () => {
	it("formatiert Sekunden als H:MM:SS", () => {
		expect(fmtHMS(0)).toBe("0:00:00");
		expect(fmtHMS(59)).toBe("0:00:59");
		expect(fmtHMS(3661)).toBe("1:01:01");
		expect(fmtHMS(-5)).toBe("0:00:00");
	});
});

describe("fmtHours", () => {
	it("nutzt deutsches Dezimalkomma", () => {
		expect(fmtHours(2.5)).toBe("2,5");
		expect(fmtHours(0)).toBe("0,0");
		expect(fmtHours(4)).toBe("4,0");
	});
});

describe("fmtHoursClock", () => {
	it("formatiert Stunden als Zeitformat H:MM", () => {
		expect(fmtHoursClock(7.5)).toBe("7:30");
		expect(fmtHoursClock(8)).toBe("8:00");
		expect(fmtHoursClock(40)).toBe("40:00");
		expect(fmtHoursClock(0)).toBe("0:00");
		expect(fmtHoursClock(3.75)).toBe("3:45");
		expect(fmtHoursClock(0.25)).toBe("0:15");
	});

	it("rundet auf ganze Minuten", () => {
		expect(fmtHoursClock(1.008)).toBe("1:00");
	});
});

describe("durationSeconds", () => {
	it("berechnet abgeschlossene Dauer", () => {
		const e: Entry = {
			id: "1",
			activityId: "a",
			startTs: 1_000_000,
			endTs: 1_000_000 + 7200 * 1000,
			note: "",
			source: "manual"
		};
		expect(durationSeconds(e)).toBe(7200);
	});

	it("nutzt now für laufende Einträge", () => {
		const start = 1_000_000;
		const now = start + 1800 * 1000;
		const e: Entry = { id: "1", activityId: "a", startTs: start, endTs: null, note: "", source: "timer" };
		expect(durationSeconds(e, now)).toBe(1800);
	});
});

describe("entryHours", () => {
	const base = { id: "1", activityId: "a", note: "", source: "manual" as const };

	it("rechnet Arbeit aus der Dauer", () => {
		const e: Entry = { ...base, startTs: 0, endTs: 9000 * 1000 };
		expect(entryHours(e, false, 7.5)).toBe(2.5);
	});

	it("rechnet Abwesenheit aus Tagesanteil * hoursPerDay", () => {
		const full: Entry = { ...base, startTs: 0, endTs: 0, dayFraction: 1 };
		const half: Entry = { ...base, startTs: 0, endTs: 0, dayFraction: 0.5 };
		const none: Entry = { ...base, startTs: 0, endTs: 0 };
		expect(entryHours(full, true, 7.5)).toBe(7.5);
		expect(entryHours(half, true, 7.5)).toBe(3.75);
		expect(entryHours(none, true, 8)).toBe(8); // ohne dayFraction = ganzer Tag
	});
});

describe("monthLabel", () => {
	it("gibt deutschen Monatsnamen", () => {
		expect(monthLabel("2026-06")).toBe("Juni 2026");
		expect(monthLabel("2026-01")).toBe("Januar 2026");
	});
});

describe("clockToMin", () => {
	it("parst gültige Zeiten", () => {
		expect(clockToMin("00:00")).toBe(0);
		expect(clockToMin("09:30")).toBe(570);
		expect(clockToMin("23:59")).toBe(1439);
		expect(clockToMin(" 8:05 ")).toBe(485);
	});

	it("gibt null bei ungültiger Eingabe", () => {
		expect(clockToMin("")).toBeNull();
		expect(clockToMin("24:00")).toBeNull();
		expect(clockToMin("12:60")).toBeNull();
		expect(clockToMin("abc")).toBeNull();
	});
});

describe("minToClock", () => {
	it("formatiert Minuten als HH:MM", () => {
		expect(minToClock(0)).toBe("00:00");
		expect(minToClock(570)).toBe("09:30");
		expect(minToClock(1439)).toBe("23:59");
	});

	it("rechnet modulo 24h und rundet", () => {
		expect(minToClock(1440)).toBe("00:00");
		expect(minToClock(1500)).toBe("01:00");
		expect(minToClock(-60)).toBe("23:00");
		expect(minToClock(90.6)).toBe("01:31");
	});
});

describe("parseClock", () => {
	it("parst Ziffern ohne Trenner", () => {
		expect(parseClock("1800")).toBe("18:00");
		expect(parseClock("830")).toBe("08:30");
		expect(parseClock("8")).toBe("08:00");
		expect(parseClock("18")).toBe("18:00");
		expect(parseClock("0")).toBe("00:00");
	});

	it("parst mit Trenner", () => {
		expect(parseClock("18:00")).toBe("18:00");
		expect(parseClock("8:05")).toBe("08:05");
		expect(parseClock("18.30")).toBe("18:30");
		expect(parseClock("18,30")).toBe("18:30");
		expect(parseClock("18h30")).toBe("18:30");
	});

	it("gibt null bei ungültiger Eingabe", () => {
		expect(parseClock("")).toBeNull();
		expect(parseClock("2500")).toBeNull();
		expect(parseClock("18:60")).toBeNull();
		expect(parseClock("12345")).toBeNull();
		expect(parseClock("abc")).toBeNull();
	});
});

describe("parseHours", () => {
	it("parst Dezimaleingabe mit Komma und Punkt", () => {
		expect(parseHours("7,5")).toBe(7.5);
		expect(parseHours("7.5")).toBe(7.5);
		expect(parseHours("0")).toBe(0);
		expect(parseHours(" 1,25 ")).toBe(1.25);
	});

	it("parst Uhrzeit-Format", () => {
		expect(parseHours("7:30")).toBe(7.5);
		expect(parseHours("0:15")).toBe(0.25);
		expect(parseHours("8:00")).toBe(8);
	});

	it("gibt null bei ungültiger Eingabe", () => {
		expect(parseHours("")).toBeNull();
		expect(parseHours("abc")).toBeNull();
		expect(parseHours("7:60")).toBeNull();
		expect(parseHours("30:00")).toBeNull(); // Uhrzeit-Format: Stunden 0–23
		expect(parseHours("-1")).toBeNull();
	});

	it("lässt große Dezimalsummen zu (Monatspauschale)", () => {
		expect(parseHours("80")).toBe(80);
		expect(parseHours("37,5")).toBe(37.5);
	});

	it("parst vierstellige HHMM-Eingabe als Uhrzeit, nicht als Stundenzahl", () => {
		expect(parseHours("0741")).toBeCloseTo(7 + 41 / 60, 10); // war fälschlich 741
		expect(parseHours("1230")).toBe(12.5);
		expect(parseHours("0800")).toBe(8);
		expect(parseHours("0015")).toBe(0.25);
		// ungültige HHMM (Minuten > 59) fällt auf Dezimal zurück
		expect(parseHours("2575")).toBe(2575);
	});
});

describe("durationHours", () => {
	it("berechnet Dauer zwischen zwei Zeiten", () => {
		expect(durationHours("09:00", "10:30")).toBe(1.5);
		expect(durationHours("08:00", "08:00")).toBe(0);
	});

	it("zählt über Mitternacht +24h", () => {
		expect(durationHours("23:00", "01:00")).toBe(2);
	});

	it("gibt 0 bei ungültiger Eingabe", () => {
		expect(durationHours("", "10:00")).toBe(0);
		expect(durationHours("09:00", "xx")).toBe(0);
	});
});

describe("toTs / noonTs", () => {
	it("toTs liefert die lokale Zeit des Tages", () => {
		const ts = toTs("2026-06-10", "08:30");
		const d = new Date(ts);
		expect(d.getFullYear()).toBe(2026);
		expect(d.getMonth()).toBe(5);
		expect(d.getDate()).toBe(10);
		expect(d.getHours()).toBe(8);
		expect(d.getMinutes()).toBe(30);
	});

	it("toTs gibt NaN bei Unsinn", () => {
		expect(Number.isNaN(toTs("kein-datum", "08:00"))).toBe(true);
	});

	it("noonTs trifft die Tagesmitte", () => {
		const d = new Date(noonTs("2026-06-10"));
		expect(d.getHours()).toBe(12);
		expect(fmtDate(noonTs("2026-06-10"))).toBe("2026-06-10");
	});

	it("noonTs bleibt an DST-Grenzen auf dem gemeinten Tag", () => {
		// Genau dafuer ist der Mittag da: um Mitternacht kippen manche Zonen
		// auf den Vortag. Deutsche Umstellungstage 2026: 29.03. und 25.10.
		for (const date of ["2026-03-29", "2026-10-25", "2026-01-01", "2026-12-31"]) {
			expect(fmtDate(noonTs(date)), date).toBe(date);
		}
	});
});

describe("fmtDateHuman", () => {
	it("formatiert deutsch mit Wochentag", () => {
		// 16.07.2026 ist ein Donnerstag.
		expect(fmtDateHuman(noonTs("2026-07-16"))).toBe("Do., 16.07.2026");
	});

	it("nennt den Vortag korrekt – der Fall beim rueckdatierten Timer-Start", () => {
		// Kurz nach Mitternacht "vor 60 Min" landet auf dem Vortag; genau darum
		// muss die Meldung den Tag benennen statt "an diesem Tag" zu sagen.
		const kurzNachMitternacht = toTs("2026-07-17", "00:53");
		const vor60Min = kurzNachMitternacht - 60 * 60 * 1000;
		expect(fmtDateHuman(vor60Min)).toBe("Do., 16.07.2026");
	});
});

describe("splitAtMidnight", () => {
	it("laesst eine Spanne innerhalb eines Tages unangetastet", () => {
		const a = toTs("2026-07-16", "08:00");
		const b = toTs("2026-07-16", "12:00");
		expect(splitAtMidnight(a, b)).toEqual([{ startTs: a, endTs: b }]);
	});

	it("teilt an Mitternacht – genau Joels 23:57–01:01", () => {
		const a = toTs("2026-07-16", "23:57");
		const b = toTs("2026-07-17", "01:01");
		const parts = splitAtMidnight(a, b);
		expect(parts).toHaveLength(2);
		expect(fmtDate(parts[0].startTs)).toBe("2026-07-16");
		expect(parts[0].endTs).toBe(toTs("2026-07-17", "00:00"));
		expect(parts[1].startTs).toBe(toTs("2026-07-17", "00:00"));
		expect(parts[1].endTs).toBe(b);
	});

	it("die Stuecke ergeben zusammen die Ausgangsspanne", () => {
		const a = toTs("2026-07-16", "23:57");
		const b = toTs("2026-07-17", "01:01");
		const sum = splitAtMidnight(a, b).reduce((s, p) => s + (p.endTs - p.startTs), 0);
		expect(sum).toBe(b - a);
	});

	it("teilt ueber mehrere Tage (App lief durch)", () => {
		const a = toTs("2026-07-16", "22:00");
		const b = toTs("2026-07-19", "03:00");
		const parts = splitAtMidnight(a, b);
		expect(parts.map((p) => fmtDate(p.startTs))).toEqual([
			"2026-07-16",
			"2026-07-17",
			"2026-07-18",
			"2026-07-19"
		]);
	});

	it("teilt ueber eine Monatsgrenze – dort landete die Zeit sonst im falschen Bericht", () => {
		const a = toTs("2026-07-31", "23:00");
		const b = toTs("2026-08-01", "01:00");
		const parts = splitAtMidnight(a, b);
		expect(parts.map((p) => fmtDate(p.startTs))).toEqual(["2026-07-31", "2026-08-01"]);
	});

	it("kommt an DST-Tagen klar (23- und 25-Stunden-Tage)", () => {
		for (const [from, to] of [
			["2026-03-29", "2026-03-30"], // Sommerzeit: 23-Stunden-Tag
			["2026-10-25", "2026-10-26"] // Winterzeit: 25-Stunden-Tag
		]) {
			const a = toTs(from, "23:30");
			const b = toTs(to, "00:30");
			const parts = splitAtMidnight(a, b);
			expect(parts.map((p) => fmtDate(p.startTs)), from).toEqual([from, to]);
			const sum = parts.reduce((s, p) => s + (p.endTs - p.startTs), 0);
			expect(sum, from).toBe(b - a);
		}
	});

	it("gibt bei Laenge 0 ein Stueck zurueck", () => {
		const a = toTs("2026-07-16", "08:00");
		expect(splitAtMidnight(a, a)).toEqual([{ startTs: a, endTs: a }]);
	});
});

describe("splitAtMidnight – manuelle Einträge", () => {
	it("teilt einen von Hand angelegten Eintrag 23:00–01:00", () => {
		// Derselbe Fall wie beim Timer, nur ueber „Eintrag" oder „Mehrere Tage":
		// vorher zaehlte die ganze Spanne auf den Starttag.
		const a = toTs("2026-07-16", "23:00");
		const b = toTs("2026-07-17", "01:00");
		const parts = splitAtMidnight(a, b);
		expect(parts.map((p) => fmtDate(p.startTs))).toEqual(["2026-07-16", "2026-07-17"]);
		expect(parts[0].endTs).toBe(startOfNextDay(a));
	});

	it("startOfNextDay trifft die Grenze auch am 25-Stunden-Tag", () => {
		// +24h waere hier eine Stunde daneben.
		const a = toTs("2026-10-25", "23:00");
		expect(startOfNextDay(a)).toBe(toTs("2026-10-26", "00:00"));
	});
});

describe("midnightSplitHint", () => {
	it("schweigt bei einer Spanne innerhalb eines Tages", () => {
		expect(midnightSplitHint(toTs("2026-07-16", "08:00"), toTs("2026-07-16", "12:00"))).toBeNull();
	});

	it("meldet die Teilung bei 23:00–01:00", () => {
		const hint = midnightSplitHint(toTs("2026-07-16", "23:00"), toTs("2026-07-17", "01:00"));
		expect(hint).toBe("über Mitternacht, wird in 2 Einträge geteilt");
	});

	it("nennt die tatsaechliche Anzahl, wenn die App durchlief", () => {
		const hint = midnightSplitHint(toTs("2026-07-16", "22:00"), toTs("2026-07-19", "03:00"));
		expect(hint).toBe("über Mitternacht, wird in 4 Einträge geteilt");
	});

	it("schweigt, wenn eine Spanne exakt an Mitternacht endet", () => {
		// Sonst warnte der letzte Eintrag des Tages vor einer Teilung, die nicht kommt.
		expect(midnightSplitHint(toTs("2026-07-16", "22:00"), toTs("2026-07-17", "00:00"))).toBeNull();
	});
});
