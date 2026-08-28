import { describe, expect, it } from "vitest";
import { diffAndStamp } from "./stamp";
import type { Entry } from "../types";

const DEV = "geraet-1";
const NOW = 1_700_000_000_000;

const e = (id: string, over: Partial<Entry> = {}): Entry => ({
	id,
	activityId: "a",
	startTs: 1000,
	endTs: 2000,
	note: "",
	source: "manual",
	...over
});

describe("diffAndStamp", () => {
	it("stempelt einen neuen Datensatz", () => {
		const { changes, stamped } = diffAndStamp([], [e("1")], DEV, NOW);
		expect(changes.changed).toHaveLength(1);
		expect(changes.deleted).toEqual([]);
		expect(stamped[0].updatedAt).toBe(NOW);
		expect(stamped[0].deviceId).toBe(DEV);
	});

	it("laesst einen unveraenderten, bereits gestempelten Datensatz in Ruhe", () => {
		const alt = e("1", { updatedAt: 500, deviceId: "anderes", rev: 7 });
		const { changes, stamped } = diffAndStamp([alt], [{ ...alt }], DEV, NOW);
		expect(changes.changed).toEqual([]);
		expect(stamped[0].updatedAt).toBe(500);
		expect(stamped[0].deviceId).toBe("anderes");
	});

	it("stempelt einen Bestandsdatensatz ohne Spuren nach", () => {
		// Daten aus einer Fassung ohne Serveranbindung: inhaltlich unveraendert,
		// aber nie gestempelt. Ohne diesen Fall bliebe der Altbestand fuer immer
		// unsynchronisiert – und genau das ist der haeufigste Fall beim Umstieg.
		const alt = e("1");
		const { changes, stamped } = diffAndStamp([alt], [{ ...alt }], DEV, NOW);
		expect(changes.changed).toHaveLength(1);
		expect(stamped[0].updatedAt).toBe(NOW);
	});

	it("erkennt eine inhaltliche Aenderung", () => {
		const alt = e("1", { updatedAt: 500, deviceId: "x" });
		const neu = { ...alt, note: "geaendert" };
		const { changes, stamped } = diffAndStamp([alt], [neu], DEV, NOW);
		expect(changes.changed).toHaveLength(1);
		expect(stamped[0].updatedAt).toBe(NOW);
		expect(stamped[0].deviceId).toBe(DEV);
	});

	it("meldet eine Loeschung samt der Fassung des Datensatzes", () => {
		// Die Fassung muss mit: der Server nimmt eine Loeschung nur auf seinem
		// aktuellen Stand an, und nach dem lokalen Loeschen ist sie sonst nirgends
		// mehr zu holen.
		const { changes } = diffAndStamp(
			[e("1", { rev: 7 }), e("2")],
			[e("2", { updatedAt: 1 })],
			DEV,
			NOW
		);
		expect(changes.deleted.map((d) => [d.id, d.rev])).toEqual([["1", 7]]);
	});

	it("stempelt beim zweiten Speichern nicht erneut", () => {
		// Der Stempel selbst darf nicht als Aenderung zaehlen, sonst stempelt jedes
		// Speichern erneut und der Abgleich laedt denselben Stand endlos hoch.
		const erst = diffAndStamp([], [e("1")], DEV, NOW);
		const zweit = diffAndStamp(erst.stamped, erst.stamped, DEV, NOW + 5000);
		expect(zweit.changes.changed).toEqual([]);
		expect(zweit.stamped[0].updatedAt).toBe(NOW);
	});

	it("reicht den Serverstand des Vorgaengers weiter", () => {
		// Damit der Abgleich weiss, auf welchem Serverstand die Aenderung aufsetzt –
		// ohne das kann der Server einen Konflikt nicht von einem Erstschreiben
		// unterscheiden.
		const alt = e("1", { updatedAt: 500, rev: 12 });
		const { stamped } = diffAndStamp([alt], [{ ...alt, note: "neu" }], DEV, NOW);
		expect(stamped[0].rev).toBe(12);
		expect(stamped[0].updatedAt).toBe(NOW);
	});

	it("haelt fehlende und undefinierte Felder fuer denselben Inhalt", () => {
		const alt = e("1", { updatedAt: 500 });
		const neu = { ...alt, dayFraction: undefined };
		expect(diffAndStamp([alt], [neu], DEV, NOW).changes.changed).toEqual([]);
	});

	it("stoert sich nicht an der Schluesselreihenfolge", () => {
		// Ein frisch gebauter Eintrag hat sie anders als einer aus JSON.parse.
		const alt = e("1", { updatedAt: 500 });
		const neu = JSON.parse(JSON.stringify({ note: "", source: "manual", endTs: 2000, startTs: 1000, activityId: "a", id: "1", updatedAt: 500 }));
		expect(diffAndStamp([alt], [neu], DEV, NOW).changes.changed).toEqual([]);
	});
});
