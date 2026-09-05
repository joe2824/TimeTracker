import { describe, expect, it } from "vitest";
import { diffAndStamp } from "./stamp";
import { anEntry as e } from "../testing/fixtures";

const DEV = "geraet-1";
const NOW = 1_700_000_000_000;


describe("diffAndStamp", () => {
	it("stempelt einen neuen Datensatz", () => {
		const { changes, stamped } = diffAndStamp([], [e("1")], DEV, NOW);
		expect(changes.changed).toHaveLength(1);
		expect(changes.deleted).toEqual([]);
		expect(stamped[0].updatedAt).toBe(NOW);
		expect(stamped[0].deviceId).toBe(DEV);
	});

	it("laesst einen unveraenderten, bereits gestempelten Datensatz in Ruhe", () => {
		const old = e("1", { updatedAt: 500, deviceId: "anderes", rev: 7 });
		const { changes, stamped } = diffAndStamp([old], [{ ...old }], DEV, NOW);
		expect(changes.changed).toEqual([]);
		expect(stamped[0].updatedAt).toBe(500);
		expect(stamped[0].deviceId).toBe("anderes");
	});

	it("stempelt einen Bestandsdatensatz ohne Spuren nach", () => {
		// Daten aus einer Fassung ohne Serveranbindung: inhaltlich unveraendert,
		// aber nie gestempelt. Ohne diesen Fall bliebe der Altbestand fuer immer
		// unsynchronisiert – und genau das ist der haeufigste Fall beim Umstieg.
		const old = e("1");
		const { changes, stamped } = diffAndStamp([old], [{ ...old }], DEV, NOW);
		expect(changes.changed).toHaveLength(1);
		expect(stamped[0].updatedAt).toBe(NOW);
	});

	it("erkennt eine inhaltliche Aenderung", () => {
		const old = e("1", { updatedAt: 500, deviceId: "x" });
		const fresh = { ...old, note: "geaendert" };
		const { changes, stamped } = diffAndStamp([old], [fresh], DEV, NOW);
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
		const first = diffAndStamp([], [e("1")], DEV, NOW);
		const second = diffAndStamp(first.stamped, first.stamped, DEV, NOW + 5000);
		expect(second.changes.changed).toEqual([]);
		expect(second.stamped[0].updatedAt).toBe(NOW);
	});

	it("reicht den Serverstand des Vorgaengers weiter", () => {
		// Damit der Abgleich weiss, auf welchem Serverstand die Aenderung aufsetzt –
		// ohne das kann der Server einen Konflikt nicht von einem Erstschreiben
		// unterscheiden.
		const old = e("1", { updatedAt: 500, rev: 12 });
		const { stamped } = diffAndStamp([old], [{ ...old, note: "neu" }], DEV, NOW);
		expect(stamped[0].rev).toBe(12);
		expect(stamped[0].updatedAt).toBe(NOW);
	});

	it("haelt fehlende und undefinierte Felder fuer denselben Inhalt", () => {
		const old = e("1", { updatedAt: 500 });
		const fresh = { ...old, dayFraction: undefined };
		expect(diffAndStamp([old], [fresh], DEV, NOW).changes.changed).toEqual([]);
	});

	it("stoert sich nicht an der Schluesselreihenfolge", () => {
		// Ein frisch gebauter Eintrag hat sie anders als einer aus JSON.parse.
		const old = e("1", { updatedAt: 500 });
		const fresh = JSON.parse(JSON.stringify({ note: "", source: "manual", endTs: 2000, startTs: 1000, activityId: "a", id: "1", updatedAt: 500 }));
		expect(diffAndStamp([old], [fresh], DEV, NOW).changes.changed).toEqual([]);
	});
});
