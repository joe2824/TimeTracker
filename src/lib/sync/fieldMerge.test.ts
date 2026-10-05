import { describe, expect, it } from "vitest";
import type { Entry } from "../types";
import { ACTIVITY_FIELDS, ENTRY_FIELDS, mergeFields, overlayTouched, stampFields } from "./fieldMerge";

const base: Entry = {
	id: "e1",
	activityId: "a1",
	startTs: 100,
	endTs: 200,
	note: "",
	source: "manual",
	updatedAt: 10,
	rev: 1,
	fieldUpdatedAt: {}
};

describe("Feldgruppen", () => {
	it("Beginn und Ende kommen immer vom selben Gerät", () => {
		// Handy verschiebt den Beginn, der Rechner danach das Ende: ein Lauf aus
		// dem Beginn des einen und dem Ende des anderen hätte niemand erfasst.
		const phone = stampFields(base, { ...base, startTs: 50 }, 20, ENTRY_FIELDS);
		const desktop = stampFields(base, { ...base, endTs: 300 }, 30, ENTRY_FIELDS);

		const merged = mergeFields(phone, { ...desktop, rev: 2 }, ENTRY_FIELDS);

		expect([merged.startTs, merged.endTs]).toEqual([100, 300]);
		expect(merged.fieldUpdatedAt).toEqual({ startTs: 30 });
	});

	it("andere Felder desselben Eintrags bleiben getrennt", () => {
		const phone = stampFields(base, { ...base, note: "Kundentermin" }, 20, ENTRY_FIELDS);
		const desktop = stampFields(base, { ...base, endTs: 300 }, 30, ENTRY_FIELDS);

		const merged = mergeFields(phone, { ...desktop, rev: 2 }, ENTRY_FIELDS);

		expect(merged).toMatchObject({ note: "Kundentermin", endTs: 300, rev: 2 });
	});

	it("ein Feld, das eine ältere Fassung entfernt hat, bleibt entfernt", () => {
		// Ohne Feldstempel ist ein fehlendes Feld bei Aktivitäten und Einträgen
		// eine Aussage (Farbe entfernt) - so alt wie der Datensatz, nicht uralt.
		const activity = { id: "a1", name: "Alpha", sortOrder: 0, archived: false, isAbsence: false };
		const local = { ...activity, color: "#f00", updatedAt: 10, rev: 1 };
		const remote = { ...activity, updatedAt: 20, rev: 2 };

		expect(mergeFields(local, remote, ACTIVITY_FIELDS)).not.toHaveProperty("color");
	});

	it("zwei Stände ohne Feldstempel bekommen keine - sonst ginge jeder Altbestand erneut hinauf", () => {
		const { fieldUpdatedAt: _, ...legacy } = base;
		const merged = mergeFields(legacy as Entry, { ...legacy, rev: 2 } as Entry, ENTRY_FIELDS);
		expect(merged.fieldUpdatedAt).toBeUndefined();
	});
});

describe("overlayTouched", () => {
	it("nimmt von der App nur die angefassten Felder, den Rest von der Platte", () => {
		const onDisk = { ...base, note: "vom Handy", updatedAt: 50, rev: 2, fieldUpdatedAt: { note: 50 } };
		const ours = { ...base, activityId: "a2" };

		const out = overlayTouched(base, ours, onDisk, ENTRY_FIELDS);

		expect(out).toMatchObject({ activityId: "a2", note: "vom Handy", rev: 2, updatedAt: 50 });
		expect(out.fieldUpdatedAt).toEqual({ note: 50 });
	});

	it("schreibt der Abgleich sein jüngeres Ergebnis, gelten dessen Fassung und Stempel", () => {
		const merged = { ...base, note: "neu", updatedAt: 80, rev: 3, fieldUpdatedAt: { note: 80 } };

		const out = overlayTouched(base, merged, base, ENTRY_FIELDS);

		expect(out).toMatchObject({ note: "neu", updatedAt: 80, rev: 3, fieldUpdatedAt: { note: 80 } });
	});
});
