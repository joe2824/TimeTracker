import { describe, expect, it } from "vitest";
import {
	addCalendarDays,
	appTimeZone,
	daysInMonth,
	isValidTimeZone,
	isoDate,
	setAppTimeZone,
	wallStringToTs,
	wallToTs,
	weekdayOfDate,
	zonedParts
} from "./tz";
import { fmtDate, splitAtMidnight, startOfNextDay, toTs } from "./time";

// Die Suite laeuft mit fest auf Berlin gesetzter Kontozone (siehe
// testing/pinZone.ts). Wo eine andere Zone geprueft wird, wird sie hier
// ausdruecklich gesetzt und danach zurueckgestellt.
function inZone<T>(tz: string, fn: () => T): T {
	const before = appTimeZone();
	expect(setAppTimeZone(tz)).toBe(true);
	try {
		return fn();
	} finally {
		setAppTimeZone(before);
	}
}

describe("setAppTimeZone", () => {
	it("weist eine unbekannte Kennung ab und behaelt die bisherige", () => {
		const before = appTimeZone();
		expect(setAppTimeZone("Mittelerde/Auenland")).toBe(false);
		expect(appTimeZone()).toBe(before);
	});

	it("erkennt gueltige Kennungen", () => {
		expect(isValidTimeZone("Europe/Berlin")).toBe(true);
		expect(isValidTimeZone("UTC")).toBe(true);
		expect(isValidTimeZone("")).toBe(false);
		expect(isValidTimeZone("Quatsch/Unfug")).toBe(false);
	});
});

describe("zonedParts / wallToTs", () => {
	it("sind zueinander invers", () => {
		for (const tz of ["Europe/Berlin", "Pacific/Kiritimati", "America/Los_Angeles", "Asia/Kolkata"]) {
			for (const ts of [Date.UTC(2026, 0, 15, 3, 27, 9), Date.UTC(2026, 6, 4, 22, 5, 41)]) {
				const p = zonedParts(ts, tz);
				expect(wallToTs(p.year, p.month, p.day, p.hour, p.minute, p.second, tz)).toBe(ts);
			}
		}
	});

	it("trifft halbstuendige und viertelstuendige Zonen", () => {
		// Indien +5:30, Nepal +5:45, Eucla +8:45 – wer nur mit vollen Stunden
		// rechnet, liegt hier daneben.
		for (const tz of ["Asia/Kolkata", "Asia/Kathmandu", "Australia/Eucla"]) {
			const ts = wallToTs(2026, 6, 10, 8, 30, 0, tz);
			const p = zonedParts(ts, tz);
			expect([p.hour, p.minute]).toEqual([8, 30]);
		}
	});

	it("liefert den Wochentag sprachunabhaengig", () => {
		// 10.06.2026 ist ein Mittwoch.
		expect(zonedParts(wallToTs(2026, 6, 10, 12), "Europe/Berlin").weekday).toBe(3);
		expect(weekdayOfDate("2026-06-10")).toBe(3);
	});
});

describe("Sommerzeit-Umstellung", () => {
	// Deutschland 2026: Beginn 29.03. (02:00 -> 03:00), Ende 25.10. (03:00 -> 02:00).
	it("der 29.03.2026 hat 23 Stunden", () => {
		const von = toTs("2026-03-29", "00:00");
		const bis = startOfNextDay(von);
		expect((bis - von) / 3_600_000).toBe(23);
	});

	it("der 25.10.2026 hat 25 Stunden", () => {
		const von = toTs("2026-10-25", "00:00");
		const bis = startOfNextDay(von);
		expect((bis - von) / 3_600_000).toBe(25);
	});

	it("die uebersprungene Stunde faellt nach vorn, statt in den Vortag zu kippen", () => {
		// 02:30 gibt es am 29.03. nicht. Ein naiver Rueckrechner landet eine Stunde
		// frueher – also noch am 28., und der Eintrag saesse am falschen Tag.
		const ts = toTs("2026-03-29", "02:30");
		expect(fmtDate(ts)).toBe("2026-03-29");
		expect(zonedParts(ts).hour).toBe(3);
	});

	it("die doppelte Stunde nimmt das erste Vorkommen", () => {
		// 02:30 gibt es am 25.10. zweimal (Sommer- und Winterzeit).
		const ts = toTs("2026-10-25", "02:30");
		expect(fmtDate(ts)).toBe("2026-10-25");
		expect(zonedParts(ts).hour).toBe(2);
		// Das zweite Vorkommen liegt eine Stunde spaeter und ist ein anderer Moment.
		expect(zonedParts(ts + 3_600_000).hour).toBe(2);
	});

	it("teilt einen Lauf ueber den 25.10. in Tagesstuecke von 25 und x Stunden", () => {
		const start = toTs("2026-10-25", "22:00");
		const ende = toTs("2026-10-26", "02:00");
		const teile = splitAtMidnight(start, ende);
		expect(teile).toHaveLength(2);
		expect(fmtDate(teile[0].startTs)).toBe("2026-10-25");
		expect(fmtDate(teile[1].startTs)).toBe("2026-10-26");
		// Kein Stueck darf ueber seine eigene Mitternacht hinausragen.
		expect(teile[0].endTs).toBe(startOfNextDay(start));
	});
});

describe("Kalenderrechnung", () => {
	it("addCalendarDays springt ueber Monats- und Jahresgrenzen", () => {
		expect(addCalendarDays("2026-01-31", 1)).toBe("2026-02-01");
		expect(addCalendarDays("2026-12-31", 1)).toBe("2027-01-01");
		expect(addCalendarDays("2026-01-01", -1)).toBe("2025-12-31");
		expect(addCalendarDays("2024-02-28", 1)).toBe("2024-02-29"); // Schaltjahr
	});

	it("addCalendarDays ueberspringt keinen Tag an einer Umstellung", () => {
		// Ueber beide deutschen Umstellungen hinweg jeden Tag einmal.
		let date = "2026-03-27";
		const gesehen: string[] = [];
		for (let i = 0; i < 5; i++) {
			gesehen.push(date);
			date = addCalendarDays(date, 1);
		}
		expect(gesehen).toEqual(["2026-03-27", "2026-03-28", "2026-03-29", "2026-03-30", "2026-03-31"]);
	});

	it("daysInMonth kennt Schaltjahre", () => {
		expect(daysInMonth(2026, 2)).toBe(28);
		expect(daysInMonth(2024, 2)).toBe(29);
		expect(daysInMonth(2000, 2)).toBe(29);
		expect(daysInMonth(1900, 2)).toBe(28);
		expect(daysInMonth(2026, 12)).toBe(31);
	});

	it("isoDate fuellt auf", () => {
		expect(isoDate(2026, 3, 7)).toBe("2026-03-07");
	});
});

describe("Unabhaengigkeit von der Geraetezone", () => {
	it("derselbe Moment ergibt in verschiedenen Kontozonen verschiedene Tage", () => {
		// Der Sinn der ganzen Uebung: der Kalendertag haengt an der KONTOzone.
		const moment = Date.UTC(2026, 5, 10, 22, 30); // 10.06.2026 22:30 UTC
		expect(inZone("Europe/Berlin", () => fmtDate(moment))).toBe("2026-06-11");
		expect(inZone("America/Los_Angeles", () => fmtDate(moment))).toBe("2026-06-10");
		expect(inZone("Pacific/Kiritimati", () => fmtDate(moment))).toBe("2026-06-11");
	});

	it("wallStringToTs weist Unsinn ab", () => {
		expect(Number.isNaN(wallStringToTs("kein-datum", "08:00"))).toBe(true);
		expect(Number.isNaN(wallStringToTs("2026-06-10", "25:00"))).toBe(true);
		expect(Number.isNaN(wallStringToTs("2026-06-10", "08:99"))).toBe(true);
	});
});
