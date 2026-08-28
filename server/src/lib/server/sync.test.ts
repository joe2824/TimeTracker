import { beforeEach, describe, expect, it } from "vitest";
import { openDb, type Db } from "./db";
import { records, users } from "./db/schema";
import { currentSeq, pullRecords, pushRecords, SyncError, type IncomingRecord } from "./sync";
import { eq } from "drizzle-orm";

let db: Db;

const ANNA = "user-anna";
const BODO = "user-bodo";

function anlegen(id: string) {
	db.insert(users).values({ id, displayName: id, createdAt: 1, seqCounter: 0 }).run();
}

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
	db = openDb(":memory:").db;
	anlegen(ANNA);
	anlegen(BODO);
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

		const spaet = pushRecords(db, ANNA, "g2", [rec("e1", { baseRev: 1, payload: "YWx0" })]);
		expect(spaet.accepted).toEqual([]);
		expect(spaet.conflicts).toHaveLength(1);
		expect(spaet.conflicts[0].current.rev).toBe(2);
		expect(spaet.conflicts[0].current.payload).toBe("bmV1");
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

	it("legt bei einer Loeschung einen Grabstein an, statt die Zeile zu entfernen", () => {
		// Ohne Grabstein haelt ein Geraet, das die Loeschung verpasst hat, seinen
		// alten Stand fuer gueltig und laedt ihn beim naechsten Mal wieder hoch.
		pushRecords(db, ANNA, "g1", [rec("e1")]);
		pushRecords(db, ANNA, "g1", [rec("e1", { baseRev: 1, deletedAt: 5000 })]);

		const zeile = db.select().from(records).where(eq(records.id, "e1")).get()!;
		expect(zeile.deletedAt).toBe(5000);
		expect(zeile.payload).toBeNull();
	});

	it("weist ein zu grosses Chiffrat ab", () => {
		const riesig = "x".repeat(64 * 1024 + 1);
		expect(() => pushRecords(db, ANNA, "g1", [rec("e1", { payload: riesig })])).toThrow(SyncError);
	});

	it("weist einen Datensatz ohne id oder Art ab", () => {
		expect(() => pushRecords(db, ANNA, "g1", [rec("")])).toThrow(SyncError);
		expect(() => pushRecords(db, ANNA, "g1", [rec("e1", { kind: "" })])).toThrow(SyncError);
	});

	it("prueft die Groesse VOR dem Schreiben, nicht mittendrin", () => {
		// Sonst laege der erste Datensatz schon da, wenn der zweite auffliegt.
		const riesig = "x".repeat(64 * 1024 + 1);
		expect(() =>
			pushRecords(db, ANNA, "g1", [rec("e1"), rec("e2", { payload: riesig })])
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
		const erste = pullRecords(db, ANNA, { limit: 2 });
		expect(erste.records).toHaveLength(2);
		expect(erste.hasMore).toBe(true);

		const zweite = pullRecords(db, ANNA, { since: erste.nextSeq, limit: 2 });
		expect(zweite.records.map((r) => r.id)).toEqual(["e3"]);
		expect(zweite.hasMore).toBe(false);
	});

	it("blaettert vollstaendig durch, ohne etwas zu ueberspringen", () => {
		const viele = Array.from({ length: 25 }, (_, i) => rec(`e${i}`));
		pushRecords(db, ANNA, "g1", viele);

		const gesehen: string[] = [];
		let since = 0;
		for (;;) {
			const seite = pullRecords(db, ANNA, { since, limit: 7 });
			gesehen.push(...seite.records.map((r) => r.id));
			since = seite.nextSeq;
			if (!seite.hasMore) break;
		}
		expect(gesehen).toHaveLength(25);
		expect(new Set(gesehen).size).toBe(25);
	});

	it("liefert einen Grabstein mit aus", () => {
		pushRecords(db, ANNA, "g1", [rec("e1")]);
		pushRecords(db, ANNA, "g1", [rec("e1", { baseRev: 1, deletedAt: 5000 })]);
		const geholt = pullRecords(db, ANNA, { since: 1 }).records;
		expect(geholt).toHaveLength(1);
		expect(geholt[0].deletedAt).toBe(5000);
	});

	it("laedt einen einzelnen Zeitraum gezielt nach", () => {
		pushRecords(db, ANNA, "g1", [
			rec("e1", { bucket: "juli" }),
			rec("e2", { bucket: "august" }),
			rec("e3", { bucket: "juli" })
		]);
		const juli = pullRecords(db, ANNA, { bucket: "juli" }).records;
		expect(juli.map((r) => r.id).sort()).toEqual(["e1", "e3"]);
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
		expect(pullRecords(db, BODO, { bucket: "geteilt" }).records).toEqual([]);
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
		const abgelehnt = pushRecords(db, ANNA, "rechner", [
			rec("e1", { baseRev: 0, payload: "cmVjaG5lcg==" })
		]);
		expect(abgelehnt.conflicts).toHaveLength(1);

		// Er uebernimmt den Serverstand und schickt auf dessen Fassung erneut.
		const stand = abgelehnt.conflicts[0].current;
		const zweiter = pushRecords(db, ANNA, "rechner", [
			rec("e1", { baseRev: stand.rev, payload: "enVzYW1tZW4=" })
		]);
		expect(zweiter.accepted).toEqual([{ id: "e1", rev: 2, seq: 2 }]);
		expect(pullRecords(db, ANNA).records[0].payload).toBe("enVzYW1tZW4=");
	});

	it("das Geraet erkennt seine eigenen Aenderungen wieder", () => {
		// Damit ein Geraet nicht auf seinen eigenen Weckruf hin neu laedt.
		pushRecords(db, ANNA, "handy", [rec("e1")]);
		expect(pullRecords(db, ANNA).records[0].deviceId).toBe("handy");
	});
});
