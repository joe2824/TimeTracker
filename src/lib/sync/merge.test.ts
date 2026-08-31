import { describe, expect, it } from "vitest";
import { mergeRecord, pickWinner, resolveOpenEntries } from "./merge";
import type { Entry } from "../types";

interface TestRecord {
	id: string;
	value: string;
	updatedAt?: number;
	rev?: number;
	deviceId?: string;
	deletedAt?: number;
}

const s = (over: Partial<TestRecord> = {}): TestRecord => ({
	id: "1",
	value: "a",
	updatedAt: 1000,
	deviceId: "geraet-a",
	...over
});

const tomb = (v: TestRecord) => v.deletedAt !== undefined;

const e = (id: string, over: Partial<Entry> = {}): Entry => ({
	id,
	activityId: "a",
	startTs: 1000,
	endTs: null,
	note: "",
	source: "timer",
	updatedAt: 1000,
	deviceId: "geraet-a",
	...over
});

describe("pickWinner", () => {
	it("der juengere Stempel gewinnt", () => {
		expect(pickWinner(s({ updatedAt: 2000 }), s({ updatedAt: 1000 }))).toBe("local");
		expect(pickWinner(s({ updatedAt: 1000 }), s({ updatedAt: 2000 }))).toBe("remote");
	});

	it("entscheidet bei Gleichstand auf BEIDEN Geraeten gleich", () => {
		// Der Punkt der Geraetekennung als Stichentscheid. Wuerde jedes Geraet bei
		// Gleichstand "meins" waehlen, ueberschrieben sie sich endlos gegenseitig.
		const a = s({ deviceId: "aaa" });
		const b = s({ deviceId: "bbb" });
		// Aus Sicht von Geraet A ist a lokal, aus Sicht von B ist b lokal.
		expect(pickWinner(a, b)).toBe("remote"); // A waehlt b
		expect(pickWinner(b, a)).toBe("local"); // B waehlt ebenfalls b
	});

	it("meldet echten Gleichstand als solchen", () => {
		expect(pickWinner(s(), s())).toBe("equal");
	});

	it("behandelt einen fehlenden Stempel als aeltesten", () => {
		expect(pickWinner(s({ updatedAt: undefined }), s({ updatedAt: 1 }))).toBe("remote");
	});
});

describe("mergeRecord", () => {
	it("uebernimmt einen unbekannten Datensatz", () => {
		const r = mergeRecord({ local: undefined, remote: s(), localPending: false }, tomb);
		expect(r.changed).toBe(true);
		expect(r.value?.value).toBe("a");
	});

	it("legt fuer einen Grabsteine ohne lokalen Stand nichts an", () => {
		// Sonst entstuende aus einer Loeschung, die uns nie betraf, eine leere Zeile.
		const r = mergeRecord(
			{ local: undefined, remote: s({ deletedAt: 5000 }), localPending: false },
			tomb
		);
		expect(r.changed).toBe(false);
		expect(r.value).toBeNull();
	});

	it("nimmt den Serverstand, wenn lokal nichts offen ist", () => {
		const r = mergeRecord(
			{ local: s({ updatedAt: 1000 }), remote: s({ value: "neu", updatedAt: 2000 }), localPending: false },
			tomb
		);
		expect(r.value?.value).toBe("neu");
		expect(r.lostLocalEdit).toBe(false);
	});

	it("nimmt den Serverstand auch dann, wenn er AELTER ist - solange nichts offen ist", () => {
		// Ohne offene eigene Aenderung ist der Server die Wahrheit. Ein aelterer
		// Stempel heisst hier nicht "veraltet", sondern dass das eigene Geraet
		// seinen Stand aus einer Quelle hat, die der Server nicht kennt.
		const r = mergeRecord(
			{ local: s({ updatedAt: 3000 }), remote: s({ value: "server", updatedAt: 2000 }), localPending: false },
			tomb
		);
		expect(r.value?.value).toBe("server");
	});

	it("laesst alles in Ruhe, wenn beide Seiten denselben Stempel haben", () => {
		const r = mergeRecord({ local: s(), remote: s(), localPending: false }, tomb);
		expect(r.changed).toBe(false);
	});

	it("behaelt die juengere eigene Aenderung", () => {
		const r = mergeRecord(
			{ local: s({ value: "meins", updatedAt: 3000 }), remote: s({ updatedAt: 2000 }), localPending: true },
			tomb
		);
		expect(r.value?.value).toBe("meins");
		expect(r.changed).toBe(false);
		expect(r.lostLocalEdit).toBe(false);
	});

	it("meldet es, wenn eine eigene Aenderung unterliegt", () => {
		// Der einzige Fall, den ein Mensch erfahren muss: seine Aenderung ist weg,
		// und zwar nicht durch sein eigenes Zutun.
		const r = mergeRecord(
			{ local: s({ value: "meins", updatedAt: 1000 }), remote: s({ value: "fremd", updatedAt: 3000 }), localPending: true },
			tomb
		);
		expect(r.value?.value).toBe("fremd");
		expect(r.lostLocalEdit).toBe(true);
	});

	it("laesst eine juengere Loeschung gewinnen", () => {
		const r = mergeRecord(
			{ local: s({ updatedAt: 1000 }), remote: s({ updatedAt: 3000, deletedAt: 3000 }), localPending: true },
			tomb
		);
		expect(r.value).toBeNull();
		expect(r.lostLocalEdit).toBe(true);
	});

	it("laesst eine juengere Bearbeitung eine aeltere Loeschung ueberleben", () => {
		// "Loeschung gewinnt immer" klaenge sicherer, machte aber das Wiederanlegen
		// eines versehentlich geloeschten Eintrags unmoeglich.
		const r = mergeRecord(
			{ local: s({ value: "wieder da", updatedAt: 5000 }), remote: s({ updatedAt: 3000, deletedAt: 3000 }), localPending: true },
			tomb
		);
		expect(r.value?.value).toBe("wieder da");
	});

	it("laesst ohne Serverstand alles unberuehrt", () => {
		const r = mergeRecord({ local: s(), remote: undefined, localPending: true }, tomb);
		expect(r.changed).toBe(false);
		expect(r.value?.value).toBe("a");
	});

	it("nimmt einen Grabstein an, auch wenn die Zeit gleich ist", () => {
		// Der Fall, der engine.test.ts flackern liess: deleteYear stempelt alle
		// Eintraege eines Jahres mit demselben Date.now(). Faellt das mit dem
		// updatedAt eines gerade erst angelegten Eintrags zusammen, standen hier
		// zwei gleiche Stempel - und die Abkuerzung fuer "derselbe Stand" nahm
		// den Grabstein nicht zur Kenntnis. Das andere Geraet behielt den
		// Eintrag und schob ihn beim naechsten Abgleich wieder hoch.
		const r = mergeRecord(
			{
				local: s({ updatedAt: 1000 }),
				remote: s({ updatedAt: 1000, deletedAt: 1000 }),
				localPending: false
			},
			tomb
		);
		expect(r.value).toBeNull();
		expect(r.changed).toBe(true);
		expect(r.lostLocalEdit).toBe(false);
	});

	it("kommt auf beiden Geraeten zum selben Ergebnis", () => {
		// Die Zusage, an der alles haengt: derselbe Code, dieselbe Ausgangslage,
		// dieselbe Entscheidung - egal, wer gerade rechnet.
		const phone = s({ id: "x", value: "handy", updatedAt: 2000, deviceId: "handy" });
		const desktop = s({ id: "x", value: "rechner", updatedAt: 2000, deviceId: "rechner" });

		const fromPhone = mergeRecord({ local: phone, remote: desktop, localPending: true }, tomb);
		const fromDesktop = mergeRecord({ local: desktop, remote: phone, localPending: true }, tomb);
		expect(fromPhone.value?.value).toBe(fromDesktop.value?.value);
	});
});

describe("resolveOpenEntries", () => {
	it("laesst einen einzelnen offenen Eintrag in Ruhe", () => {
		expect(resolveOpenEntries([e("1"), e("2", { endTs: 5000 })])).toEqual([]);
	});

	it("laesst gar keinen offenen Eintrag in Ruhe", () => {
		expect(resolveOpenEntries([e("1", { endTs: 2000 })])).toEqual([]);
	});

	it("beendet den aelteren, wenn zwei Geraete je einen offenen halten", () => {
		// Der Fall, um den es geht: am Handy gestartet, der Rechner wacht auf und
		// weiss nichts davon.
		const phone = e("h", { startTs: 1000, updatedAt: 1000, deviceId: "handy" });
		const desktop = e("r", { startTs: 5000, updatedAt: 9000, deviceId: "rechner" });
		const fix = resolveOpenEntries([phone, desktop]);
		expect(fix).toHaveLength(1);
		expect(fix[0].id).toBe("h");
		expect(fix[0].endTs).toBe(5000);
	});

	it("entscheidet nach der juengsten HANDLUNG, nicht nach der Startzeit", () => {
		// Wer um 10 am Rechner startet und dabei auf 8 Uhr zurueckdatiert, meint
		// trotzdem diesen Lauf - nicht den vom Handy um 9.
		const early = e("neu", { startTs: 8000, updatedAt: 10_000, deviceId: "rechner" });
		const late = e("alt", { startTs: 9000, updatedAt: 9000, deviceId: "handy" });
		const fix = resolveOpenEntries([early, late]);
		expect(fix.map((x) => x.id)).toEqual(["alt"]);
	});

	it("laesst keine negative Dauer entstehen", () => {
		// Wenn der Gewinner VOR dem Verlierer begann, endet der Verlierer an seinem
		// eigenen Start - Dauer null statt negativ.
		const winner = e("g", { startTs: 1000, updatedAt: 9000 });
		const loser = e("v", { startTs: 5000, updatedAt: 1000 });
		const fix = resolveOpenEntries([winner, loser]);
		expect(fix[0].endTs).toBe(5000);
	});

	it("beendet bei drei offenen alle bis auf einen", () => {
		const fix = resolveOpenEntries([
			e("a", { updatedAt: 1000 }),
			e("b", { updatedAt: 2000 }),
			e("c", { updatedAt: 3000 })
		]);
		expect(fix.map((x) => x.id).sort()).toEqual(["a", "b"]);
	});

	it("waehlt auf beiden Geraeten denselben Gewinner", () => {
		const a = e("a", { updatedAt: 5000, deviceId: "aaa" });
		const b = e("b", { updatedAt: 5000, deviceId: "bbb" });
		expect(resolveOpenEntries([a, b]).map((x) => x.id)).toEqual(
			resolveOpenEntries([b, a]).map((x) => x.id)
		);
	});
});
