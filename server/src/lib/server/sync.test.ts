import { beforeEach, describe, expect, it } from "vitest";
import { type Db } from "./db";
import { ANNA, BODO, freshDb } from "./testing/fixtures";
import { records, users } from "./db/schema";
import {
	currentSeq,
	listBuckets,
	pullRecords,
	pushRecords,
	SyncError,
	type IncomingRecord
} from "./sync";
import { MAX_BUCKETS } from "./config";
import { eq } from "drizzle-orm";

let db: Db;


const rec = (id: string, over: Partial<IncomingRecord> = {}): IncomingRecord => ({
	id,
	kind: "entry",
	bucket: "a1b2",
	baseRev: 0,
	updatedAt: 1000,
	payload: "Y2hpZmZyYXQ=",
	...over
});

beforeEach(() => {
	db = freshDb();
});

describe("Ablegen", () => {
	it("nimmt einen neuen Datensatz an und vergibt Fassung und Nummer", () => {
		const r = pushRecords(db, ANNA, "geraet-1", [rec("e1")]);
		expect(r.accepted).toEqual([{ id: "e1", rev: 1, seq: 1 }]);
		expect(r.conflicts).toEqual([]);
	});

	it("zaehlt die Nummer je Datensatz weiter", () => {
		const r = pushRecords(db, ANNA, "g1", [rec("e1"), rec("e2"), rec("e3")]);
		expect(r.accepted.map((a) => a.seq)).toEqual([1, 2, 3]);
		expect(currentSeq(db, ANNA)).toBe(3);
	});

	it("nimmt eine Aenderung an, wenn die Fassung stimmt", () => {
		pushRecords(db, ANNA, "g1", [rec("e1")]);
		const r = pushRecords(db, ANNA, "g1", [rec("e1", { baseRev: 1, updatedAt: 2000 })]);
		expect(r.accepted).toEqual([{ id: "e1", rev: 2, seq: 2 }]);
	});

	it("weist eine Aenderung auf veraltetem Stand ab", () => {
		// Der Kern des Ganzen: zwei Geraete duerfen sich nicht gegenseitig
		// ueberschreiben, ohne die Aenderung des anderen gesehen zu haben.
		pushRecords(db, ANNA, "g1", [rec("e1")]);
		pushRecords(db, ANNA, "g1", [rec("e1", { baseRev: 1, payload: "bmV1" })]);

		const late = pushRecords(db, ANNA, "g2", [rec("e1", { baseRev: 1, payload: "YWx0" })]);
		expect(late.accepted).toEqual([]);
		expect(late.conflicts).toHaveLength(1);
		expect(late.conflicts[0].current.rev).toBe(2);
		expect(late.conflicts[0].current.payload).toBe("bmV1");
	});

	it("meldet einen leeren Stand, wenn der Datensatz beim Server fehlt", () => {
		// Etwa nach einem wiederhergestellten Backup. Ohne diesen Fall liefe der
		// Client in eine Schleife aus immer wieder abgelehnten Versuchen.
		const r = pushRecords(db, ANNA, "g1", [rec("e1", { baseRev: 5 })]);
		expect(r.accepted).toEqual([]);
		expect(r.conflicts[0].current.rev).toBe(0);
	});

	it("laesst angenommene und abgelehnte Datensaetze nebeneinander zu", () => {
		pushRecords(db, ANNA, "g1", [rec("e1")]);
		const r = pushRecords(db, ANNA, "g2", [rec("e1", { baseRev: 0 }), rec("e2")]);
		expect(r.accepted.map((a) => a.id)).toEqual(["e2"]);
		expect(r.conflicts.map((c) => c.id)).toEqual(["e1"]);
	});

	it("legt bei einer Loeschung einen Loeschmarker an, statt die Zeile zu entfernen", () => {
		// Ohne Loeschmarker haelt ein Geraet, das die Loeschung verpasst hat, seinen
		// alten Stand fuer gueltig und laedt ihn beim naechsten Mal wieder hoch.
		pushRecords(db, ANNA, "g1", [rec("e1")]);
		pushRecords(db, ANNA, "g1", [rec("e1", { baseRev: 1, deletedAt: 5000 })]);

		const rowText = db.select().from(records).where(eq(records.id, "e1")).get()!;
		expect(rowText.deletedAt).toBe(5000);
		expect(rowText.payload).toBeNull();
	});

	it("weist ein zu grosses Chiffrat ab", () => {
		const huge = "x".repeat(64 * 1024 + 1);
		expect(() => pushRecords(db, ANNA, "g1", [rec("e1", { payload: huge })])).toThrow(SyncError);
	});

	it("weist einen Datensatz ohne id oder Art ab", () => {
		expect(() => pushRecords(db, ANNA, "g1", [rec("")])).toThrow(SyncError);
		expect(() => pushRecords(db, ANNA, "g1", [rec("e1", { kind: "" })])).toThrow(SyncError);
	});

	it("prueft die Groesse VOR dem Schreiben, nicht mittendrin", () => {
		// Sonst laege der erste Datensatz schon da, wenn der zweite auffliegt.
		const huge = "x".repeat(64 * 1024 + 1);
		expect(() =>
			pushRecords(db, ANNA, "g1", [rec("e1"), rec("e2", { payload: huge })])
		).toThrow(SyncError);
		expect(currentSeq(db, ANNA)).toBe(0);
		expect(pullRecords(db, ANNA).records).toEqual([]);
	});

	it("weist ein unbekanntes Konto ab", () => {
		expect(() => pushRecords(db, "gibt-es-nicht", null, [rec("e1")])).toThrow(SyncError);
	});
});

describe("Abholen", () => {
	it("liefert nur Neueres als der genannte Stand", () => {
		pushRecords(db, ANNA, "g1", [rec("e1"), rec("e2")]);
		pushRecords(db, ANNA, "g1", [rec("e3")]);
		expect(pullRecords(db, ANNA, { since: 2 }).records.map((r) => r.id)).toEqual(["e3"]);
	});

	it("liefert in der Reihenfolge der Nummern", () => {
		pushRecords(db, ANNA, "g1", [rec("e1"), rec("e2"), rec("e3")]);
		const seqs = pullRecords(db, ANNA).records.map((r) => r.seq);
		expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
	});

	it("blaettert und meldet ehrlich, ob noch etwas kommt", () => {
		pushRecords(db, ANNA, "g1", [rec("e1"), rec("e2"), rec("e3")]);
		const first = pullRecords(db, ANNA, { limit: 2 });
		expect(first.records).toHaveLength(2);
		expect(first.hasMore).toBe(true);

		const secondB = pullRecords(db, ANNA, { since: first.nextSeq, limit: 2 });
		expect(secondB.records.map((r) => r.id)).toEqual(["e3"]);
		expect(secondB.hasMore).toBe(false);
	});

	it("blaettert vollstaendig durch, ohne etwas zu ueberspringen", () => {
		const many = Array.from({ length: 25 }, (_, i) => rec(`e${i}`));
		pushRecords(db, ANNA, "g1", many);

		const seen: string[] = [];
		let since = 0;
		for (;;) {
			const pageNo = pullRecords(db, ANNA, { since, limit: 7 });
			seen.push(...pageNo.records.map((r) => r.id));
			since = pageNo.nextSeq;
			if (!pageNo.hasMore) break;
		}
		expect(seen).toHaveLength(25);
		expect(new Set(seen).size).toBe(25);
	});

	it("liefert einen Loeschmarker mit aus", () => {
		pushRecords(db, ANNA, "g1", [rec("e1")]);
		pushRecords(db, ANNA, "g1", [rec("e1", { baseRev: 1, deletedAt: 5000 })]);
		const fetched = pullRecords(db, ANNA, { since: 1 }).records;
		expect(fetched).toHaveLength(1);
		expect(fetched[0].deletedAt).toBe(5000);
	});

	it("laedt einen einzelnen Zeitraum gezielt nach", () => {
		pushRecords(db, ANNA, "g1", [
			rec("e1", { bucket: "juli" }),
			rec("e2", { bucket: "august" }),
			rec("e3", { bucket: "juli" })
		]);
		const july = pullRecords(db, ANNA, { buckets: ["juli"] }).records;
		expect(july.map((r) => r.id).sort()).toEqual(["e1", "e3"]);
	});

	it("laedt mehrere Zeitraeume in einem Zug", () => {
		pushRecords(db, ANNA, "g1", [
			rec("e1", { bucket: "juli" }),
			rec("e2", { bucket: "august" }),
			rec("e3", { bucket: "september" })
		]);
		const page = pullRecords(db, ANNA, { buckets: ["juli", "september"] }).records;
		expect(page.map((r) => r.id).sort()).toEqual(["e1", "e3"]);
	});

	it("nimmt die Datensaetze ohne Zeitraum auf Wunsch mit", () => {
		pushRecords(db, ANNA, "g1", [
			rec("e1", { bucket: "juli" }),
			rec("e2", { bucket: "august" }),
			rec("s1", { bucket: null })
		]);
		const page = pullRecords(db, ANNA, {
			buckets: ["juli"],
			includeUnbucketed: true
		}).records;
		expect(page.map((r) => r.id).sort()).toEqual(["e1", "s1"]);
	});

	it("laesst die Datensaetze ohne Zeitraum sonst draussen", () => {
		pushRecords(db, ANNA, "g1", [rec("e1", { bucket: "juli" }), rec("s1", { bucket: null })]);
		const page = pullRecords(db, ANNA, { buckets: ["juli"] }).records;
		expect(page.map((r) => r.id)).toEqual(["e1"]);
	});

	it("holt nur die Datensaetze ohne Zeitraum, wenn kein Bucket genannt ist", () => {
		pushRecords(db, ANNA, "g1", [rec("e1", { bucket: "juli" }), rec("s1", { bucket: null })]);
		const page = pullRecords(db, ANNA, { includeUnbucketed: true }).records;
		expect(page.map((r) => r.id)).toEqual(["s1"]);
	});

	it("eine leere Bucket-Liste liefert nichts - nicht alles", () => {
		// Der Unterschied ist der Punkt: eingeschraenkt auf nichts ist nicht
		// dasselbe wie gar nicht eingeschraenkt.
		pushRecords(db, ANNA, "g1", [rec("e1", { bucket: "juli" }), rec("s1", { bucket: null })]);
		expect(pullRecords(db, ANNA, { buckets: [] }).records).toEqual([]);
	});

	it("nextSeq und hasMore gelten fuer die gefilterte Menge", () => {
		pushRecords(db, ANNA, "g1", [
			rec("e1", { bucket: "juli" }),
			rec("e2", { bucket: "august" }),
			rec("e3", { bucket: "juli" }),
			rec("e4", { bucket: "juli" })
		]);
		const first = pullRecords(db, ANNA, { buckets: ["juli"], limit: 2 });
		expect(first.records.map((r) => r.id)).toEqual(["e1", "e3"]);
		expect(first.hasMore).toBe(true);
		const second = pullRecords(db, ANNA, {
			buckets: ["juli"],
			since: first.nextSeq,
			limit: 2
		});
		expect(second.records.map((r) => r.id)).toEqual(["e4"]);
		expect(second.hasMore).toBe(false);
	});

	it("weist eine masslose Bucket-Liste ab", () => {
		const many = Array.from({ length: MAX_BUCKETS + 1 }, (_, i) => `b${i}`);
		expect(() => pullRecords(db, ANNA, { buckets: many })).toThrow(SyncError);
	});

	it("deckelt eine masslose Seitengroesse", () => {
		pushRecords(db, ANNA, "g1", [rec("e1")]);
		expect(() => pullRecords(db, ANNA, { limit: 10_000_000 })).not.toThrow();
	});
});

describe("Mandantentrennung", () => {
	it("Anna sieht nichts von Bodo", () => {
		pushRecords(db, ANNA, "g1", [rec("a1")]);
		pushRecords(db, BODO, "g2", [rec("b1")]);
		expect(pullRecords(db, ANNA).records.map((r) => r.id)).toEqual(["a1"]);
		expect(pullRecords(db, BODO).records.map((r) => r.id)).toEqual(["b1"]);
	});

	it("gleiche Ids in zwei Konten stoeren einander nicht", () => {
		// Die Ids sind zufaellig, aber der Server darf sich nicht darauf verlassen.
		pushRecords(db, ANNA, "g1", [rec("gleiche-id", { payload: "YW5uYQ==" })]);
		pushRecords(db, BODO, "g2", [rec("gleiche-id", { payload: "Ym9kbw==" })]);
		expect(pullRecords(db, ANNA).records[0].payload).toBe("YW5uYQ==");
		expect(pullRecords(db, BODO).records[0].payload).toBe("Ym9kbw==");
	});

	it("die laufenden Nummern der Konten sind voneinander unabhaengig", () => {
		// Sonst verriete der Abstand zweier Nummern, wie viel andere Konten
		// dazwischen geschrieben haben.
		pushRecords(db, ANNA, "g1", [rec("a1")]);
		pushRecords(db, BODO, "g2", [rec("b1"), rec("b2"), rec("b3")]);
		pushRecords(db, ANNA, "g1", [rec("a2")]);
		expect(pullRecords(db, ANNA).records.map((r) => r.seq)).toEqual([1, 2]);
	});

	it("Bodos Zeitraum-Kennung holt nichts von Anna", () => {
		pushRecords(db, ANNA, "g1", [rec("a1", { bucket: "geteilt" })]);
		expect(pullRecords(db, BODO, { buckets: ["geteilt"] }).records).toEqual([]);
	});

	it("Bodo sieht Annas Zeitraum-Kennungen nicht in der Liste", () => {
		pushRecords(db, ANNA, "g1", [rec("a1", { bucket: "anna-juli" })]);
		pushRecords(db, BODO, "g2", [rec("b1", { bucket: "bodo-juli" })]);
		expect(listBuckets(db, BODO)).toEqual(["bodo-juli"]);
	});

	it("Bodo kann Annas Datensatz nicht ueberschreiben", () => {
		pushRecords(db, ANNA, "g1", [rec("a1", { payload: "YW5uYQ==" })]);
		// Bodo schreibt mit derselben Id - fuer ihn ist sie neu.
		pushRecords(db, BODO, "g2", [rec("a1", { payload: "Ym9kbw==" })]);
		expect(pullRecords(db, ANNA).records[0].payload).toBe("YW5uYQ==");
	});
});

describe("Zwei Geraete am selben Konto", () => {
	it("der Nachzuegler fuehrt zusammen und kommt beim zweiten Versuch durch", () => {
		// Der vollstaendige Ablauf, wie ihn der Client durchlaeuft.
		pushRecords(db, ANNA, "handy", [rec("e1", { payload: "ZXJzdA==" })]);

		// Der Rechner kennt nur Fassung 1 und wird abgewiesen.
		const rejected = pushRecords(db, ANNA, "rechner", [
			rec("e1", { baseRev: 0, payload: "cmVjaG5lcg==" })
		]);
		expect(rejected.conflicts).toHaveLength(1);

		// Er uebernimmt den Serverstand und schickt auf dessen Fassung erneut.
		const knownSeq = rejected.conflicts[0].current;
		const secondC = pushRecords(db, ANNA, "rechner", [
			rec("e1", { baseRev: knownSeq.rev, payload: "enVzYW1tZW4=" })
		]);
		expect(secondC.accepted).toEqual([{ id: "e1", rev: 2, seq: 2 }]);
		expect(pullRecords(db, ANNA).records[0].payload).toBe("enVzYW1tZW4=");
	});

	it("das Geraet erkennt seine eigenen Aenderungen wieder", () => {
		// Damit ein Geraet nicht auf seinen eigenen Weckruf hin neu laedt.
		pushRecords(db, ANNA, "handy", [rec("e1")]);
		expect(pullRecords(db, ANNA).records[0].deviceId).toBe("handy");
	});
});

describe("listBuckets", () => {
	it("nennt jede Kennung genau einmal", () => {
		pushRecords(db, ANNA, "g1", [
			rec("e1", { bucket: "juli" }),
			rec("e2", { bucket: "juli" }),
			rec("e3", { bucket: "august" })
		]);
		expect(listBuckets(db, ANNA).sort()).toEqual(["august", "juli"]);
	});

	it("laesst die Datensaetze ohne Kennung weg", () => {
		pushRecords(db, ANNA, "g1", [rec("e1", { bucket: "juli" }), rec("s1", { bucket: null })]);
		expect(listBuckets(db, ANNA)).toEqual(["juli"]);
	});

	it("ein leeres Konto liefert eine leere Liste", () => {
		expect(listBuckets(db, ANNA)).toEqual([]);
	});
});
