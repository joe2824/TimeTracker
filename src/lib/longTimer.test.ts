import { describe, expect, it } from "vitest";
import { checkEnd, suggestLongTimerEnd } from "./longTimer";

const H = 3600 * 1000;
const MIN = 60 * 1000;
/** 19.08.2026, lokal */
const D19 = new Date(2026, 7, 19, 0, 0, 0).getTime();
const D20 = new Date(2026, 7, 20, 0, 0, 0).getTime();
const at = (day: number, h: number, m = 0) => day + h * H + m * MIN;

const BASE = { hoursPerDay: 7.5, deductBreaks: true };

describe("suggestLongTimerEnd", () => {
	it("schlaegt am selben Tag „jetzt“ vor", () => {
		const now = at(D19, 17, 3);
		const ts = suggestLongTimerEnd({
			...BASE,
			runStartTs: at(D19, 9),
			dayStartTs: at(D19, 9),
			now
		});
		expect(ts).toBe(now);
	});

	it("bleibt ueber Nacht auf dem Starttag – Joels Fall", () => {
		// Timer ab 19.08. 14:00 vergessen, Dialog erscheint am 20.08. um 08:36.
		// Tagesbeginn 08:27 + 8,25 h Soll-Anwesenheit -> 16:42 am 19.08.
		const ts = suggestLongTimerEnd({
			...BASE,
			runStartTs: at(D19, 14, 0),
			dayStartTs: at(D19, 8, 27),
			now: at(D20, 8, 36)
		});
		expect(ts).toBe(at(D19, 16, 42));
		expect(new Date(ts).getDate()).toBe(19);
	});

	it("faellt ohne Tagesbeginn auf den Laufbeginn zurueck", () => {
		const ts = suggestLongTimerEnd({
			...BASE,
			runStartTs: at(D19, 9),
			dayStartTs: null,
			now: at(D20, 10)
		});
		expect(ts).toBe(at(D19, 17, 15)); // 9:00 + 8,25 h
	});

	it("rechnet ohne Pausenabzug mit dem reinen Soll", () => {
		const ts = suggestLongTimerEnd({
			hoursPerDay: 7.5,
			deductBreaks: false,
			runStartTs: at(D19, 9),
			dayStartTs: at(D19, 9),
			now: at(D20, 10)
		});
		expect(ts).toBe(at(D19, 16, 30));
	});

	it("kappt am Ende des Starttags, statt in die Nacht zu rutschen", () => {
		// Spaeter Beginn: Tagesbeginn + Soll laege nach Mitternacht.
		const ts = suggestLongTimerEnd({
			...BASE,
			runStartTs: at(D19, 22, 0),
			dayStartTs: at(D19, 21, 0),
			now: at(D20, 10)
		});
		expect(ts).toBe(at(D19, 23, 59));
	});

	it("liegt nie vor dem Laufbeginn", () => {
		// Der Lauf begann nach dem geschaetzten Feierabend.
		const ts = suggestLongTimerEnd({
			...BASE,
			runStartTs: at(D19, 19, 0),
			dayStartTs: at(D19, 8, 0),
			now: at(D20, 10)
		});
		expect(ts).toBe(at(D19, 19, 1));
	});

	it("geht nie ueber „jetzt“ hinaus", () => {
		// Dialog kommt kurz nach Mitternacht: der geschaetzte Feierabend liegt
		// dann zwar am Starttag, aber trotzdem in der Zukunft? Nein – hier
		// begrenzt „jetzt“ zusaetzlich.
		const now = at(D20, 0, 30);
		const ts = suggestLongTimerEnd({
			...BASE,
			runStartTs: at(D19, 23, 0),
			dayStartTs: at(D19, 23, 0),
			now
		});
		expect(ts).toBeLessThanOrEqual(now);
	});
});

describe("checkEnd", () => {
	const START = at(D19, 14);
	const NOW = at(D20, 8, 36);

	it("nimmt eine Zeit zwischen Start und jetzt an", () => {
		expect(checkEnd(at(D19, 18, 26), START, NOW)).toBeNull();
	});

	it("meldet die Zukunft, statt still auf jetzt zu klemmen", () => {
		// Genau der Fehler: im Feld nur „18:26“ getippt, Datum blieb auf HEUTE.
		expect(checkEnd(at(D20, 18, 26), START, NOW)).toBe("future");
	});

	it("meldet eine Zeit vor dem Laufbeginn", () => {
		expect(checkEnd(at(D19, 13), START, NOW)).toBe("before-start");
	});

	it("meldet ein unlesbares Datum", () => {
		expect(checkEnd(NaN, START, NOW)).toBe("invalid");
	});
});
