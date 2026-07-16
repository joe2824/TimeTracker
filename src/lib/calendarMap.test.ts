import { describe, expect, it } from "vitest";
import { absenceAllowed, activityOptions, guessActivity } from "./calendarMap";
import type { Activity } from "./types";

function act(id: string, name: string, isAbsence = false): Activity {
	return { id, name, sortOrder: 0, archived: false, isAbsence };
}

const ABS = act("abs", "Abwesenheiten", true);
const P1 = act("p1", "Projekt 1");
const WARTUNG = act("w", "Wartung");
const ACTIVITIES = [P1, WARTUNG, ABS];

/** Termin mit Uhrzeit. */
const timed = (subject: string) => ({ subject, allDay: false });
/** Ganztags-Termin. */
const allDay = (subject: string) => ({ subject, allDay: true });

describe("absenceAllowed", () => {
	it("erlaubt Abwesenheit nur bei Ganztags-Terminen", () => {
		expect(absenceAllowed({ allDay: true })).toBe(true);
		expect(absenceAllowed({ allDay: false })).toBe(false);
	});
});

describe("activityOptions", () => {
	it("laesst Abwesenheiten bei Terminen mit Uhrzeit weg", () => {
		expect(activityOptions(timed("Zahnarzt"), ACTIVITIES).map((a) => a.id)).toEqual(["p1", "w"]);
	});

	it("bietet sie bei Ganztags-Terminen an", () => {
		expect(activityOptions(allDay("Urlaub"), ACTIVITIES).map((a) => a.id)).toEqual([
			"p1",
			"w",
			"abs"
		]);
	});
});

describe("guessActivity", () => {
	it("schlaegt fuer Ganztags-Termine die Abwesenheit vor", () => {
		expect(guessActivity(allDay("Urlaub"), ACTIVITIES, {})).toBe("abs");
	});

	it("macht aus einem Termin MIT Uhrzeit nie eine Abwesenheit", () => {
		// Frueher wurde ein zweistuendiger Arzttermin (busyStatus "abwesend")
		// automatisch zum halben Urlaubstag.
		expect(guessActivity(timed("Zahnarzt"), ACTIVITIES, {})).toBe("");
	});

	it("ignoriert eine Altlast 'Stichwort -> Abwesenheiten' bei Uhrzeit-Terminen", () => {
		const legacy = { zahnarzt: "abs" };
		expect(guessActivity(timed("Zahnarzt Termin"), ACTIVITIES, legacy)).toBe("");
	});

	it("nutzt die Stichwort-Zuordnung fuer normale Aktivitaeten", () => {
		expect(guessActivity(timed("Daily Projekt-Sync"), ACTIVITIES, { sync: "p1" })).toBe("p1");
	});

	it("faellt auf einen Namenstreffer zurueck", () => {
		expect(guessActivity(timed("Wartung Anlage 4"), ACTIVITIES, {})).toBe("w");
	});

	it("liefert '' wenn nichts passt", () => {
		expect(guessActivity(timed("Kaffee"), ACTIVITIES, {})).toBe("");
	});

	it("kommt ohne Abwesenheits-Aktivitaet klar", () => {
		expect(guessActivity(allDay("Urlaub"), [P1], {})).toBe("");
	});
});
