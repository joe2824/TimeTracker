// Der Bestand im Browser muss sich genau so verhalten wie der auf der Platte.
//
// Nicht "aehnlich": store.ts unterscheidet an mehreren Stellen zwischen "Datei
// fehlt" und "Datei ist kaputt", zwischen "leer" und "klein", und es verlaesst
// sich darauf, dass ein Umbenennen das Ziel ersetzt. Weicht die Ablage in einem
// dieser Punkte ab, faellt das nicht als Fehler auf - es loescht still Daten.
//
// Deshalb laeuft hier EINE Testreihe gegen die Ablage in IndexedDB, mit
// denselben Erwartungen, die store.ts an sie stellt.
import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import { storage, useBrowserStorage } from "./fs";

useBrowserStorage();

async function leeren(): Promise<void> {
	for (const e of await storage.readDir("data")) {
		await storage.remove(`data/${e.name}`);
	}
}

beforeEach(leeren);

describe("Ablage im Browser", () => {
	it("schreibt und liest wieder", async () => {
		await storage.writeTextFile("data/a.json", '{"x":1}');
		expect(await storage.readTextFile("data/a.json")).toBe('{"x":1}');
	});

	it("weiss, was es gibt und was nicht", async () => {
		expect(await storage.exists("data/a.json")).toBe(false);
		await storage.writeTextFile("data/a.json", "x");
		expect(await storage.exists("data/a.json")).toBe(true);
	});

	it("wirft beim Lesen einer fehlenden Datei", async () => {
		// store.ts faengt genau das ab. Ein leerer String stattdessen saehe aus wie
		// eine vorhandene, leere Datei - und die wird anders behandelt.
		await expect(storage.readTextFile("data/gibts-nicht.json")).rejects.toThrow();
	});

	it("ueberschreibt beim zweiten Schreiben", async () => {
		await storage.writeTextFile("data/a.json", "alt");
		await storage.writeTextFile("data/a.json", "neu");
		expect(await storage.readTextFile("data/a.json")).toBe("neu");
	});

	it("loescht", async () => {
		await storage.writeTextFile("data/a.json", "x");
		await storage.remove("data/a.json");
		expect(await storage.exists("data/a.json")).toBe(false);
	});

	it("benennt um und ersetzt dabei das Ziel", async () => {
		// Daran haengt das atomare Schreiben in store.ts: erst in eine Zwischendatei,
		// dann umbenennen. Ersetzt das Umbenennen nicht, bliebe der alte Stand stehen.
		await storage.writeTextFile("data/ziel.json", "alt");
		await storage.writeTextFile("data/tmp.json", "neu");
		await storage.rename("data/tmp.json", "data/ziel.json");
		expect(await storage.readTextFile("data/ziel.json")).toBe("neu");
		expect(await storage.exists("data/tmp.json")).toBe(false);
	});

	it("wirft beim Umbenennen einer fehlenden Datei", async () => {
		await expect(storage.rename("data/weg.json", "data/x.json")).rejects.toThrow();
	});

	it("listet nur die eigene Ebene", async () => {
		await storage.writeTextFile("data/a.json", "1");
		await storage.writeTextFile("data/b.json", "2");
		await storage.writeTextFile("logs/c.log", "3");
		const namen = (await storage.readDir("data")).map((e) => e.name).sort();
		expect(namen).toEqual(["a.json", "b.json"]);
	});

	it("misst die Groesse in Bytes, nicht in Zeichen", async () => {
		// store.ts entscheidet an dieser Zahl, ob eine Monatsdatei klein genug ist,
		// um leer zu sein. Ein Umlaut zaehlt zwei Bytes - wer Zeichen zaehlt, haelt
		// eine volle Datei fuer leer und loescht sie.
		await storage.writeTextFile("data/u.json", "äöü");
		expect((await storage.stat("data/u.json")).size).toBe(6);
	});

	it("meldet die Groesse einer leeren Ablage als null", async () => {
		await storage.writeTextFile("data/leer.json", "");
		expect((await storage.stat("data/leer.json")).size).toBe(0);
	});

	it("wirft beim Messen einer fehlenden Datei", async () => {
		await expect(storage.stat("data/weg.json")).rejects.toThrow();
	});

	it("nimmt einen Ordner ohne Murren an", async () => {
		// Es gibt keine Ordner - der Aufruf muss trotzdem durchgehen, weil store.ts
		// ihn vor jedem Schreiben macht.
		await expect(storage.mkdir("data")).resolves.toBeUndefined();
	});

	it("liefert fuer einen leeren Ordner eine leere Liste", async () => {
		expect(await storage.readDir("data")).toEqual([]);
	});
});

describe("store.ts auf der Browser-Ablage", () => {
	it("legt Eintraege ab und liest sie wieder", async () => {
		// Der eigentliche Nachweis: nicht die Ablage fuer sich, sondern store.ts
		// darauf - mit derselben Quarantaene-, Aufraeum- und Loeschlogik wie auf
		// dem Rechner.
		const store = await import("../store");
		const eintrag = {
			id: "e1",
			activityId: "a",
			startTs: 1000,
			endTs: 2000,
			note: "Notiz",
			source: "manual" as const
		};
		await store.saveEntries("2026-07", [eintrag]);
		expect(await store.loadEntries("2026-07")).toEqual([eintrag]);
		expect(await store.listEntryMonths()).toEqual(["2026-07"]);

		// Ein leerer Monat hinterlaesst keine Datei.
		await store.saveEntries("2026-07", []);
		expect(await store.listEntryMonths()).toEqual([]);
	});

	it("legt eine beschaedigte Datei zur Seite, statt sie fuer leer zu halten", async () => {
		const store = await import("../store");
		await storage.writeTextFile("data/entries-2026-08.json", "{kaputt");
		expect(await store.loadEntries("2026-08")).toEqual([]);
		// Der Monat taucht danach nicht mehr in der Liste auf - die Datei heisst
		// jetzt anders und wird weder gelistet noch aufgeraeumt.
		expect(await store.listEntryMonths()).toEqual([]);
		const namen = (await storage.readDir("data")).map((e) => e.name);
		expect(namen.some((n) => n.includes("beschaedigt"))).toBe(true);
	});
});
