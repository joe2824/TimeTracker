import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { openIndexedDbStore } from "./indexedDb";

describe("openIndexedDbStore", () => {
	it("liest zurück, was geschrieben wurde", async () => {
		const db = openIndexedDbStore("idb-test-roundtrip", "s");
		await db.tx("readwrite", (s) => s.put("wert", "k"));
		expect(await db.tx<string>("readonly", (s) => s.get("k"))).toBe("wert");
	});

	it("meldet ein Schreiben erst als gelungen, wenn die Transaktion durch ist", async () => {
		const db = openIndexedDbStore("idb-test-abort", "s");
		// Die Anfrage selbst gelingt, die Transaktion scheitert danach - so sieht
		// ein volles Kontingent aus.
		const write = db.tx("readwrite", (s) => {
			const req = s.put("wert", "k");
			req.addEventListener("success", () => s.transaction.abort());
			return req;
		});
		await expect(write).rejects.toBeDefined();
		expect(await db.tx("readonly", (s) => s.get("k"))).toBeUndefined();
	});
});
