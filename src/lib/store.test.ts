import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Entry } from "./types";
import { blockWrites, fakeFs, files, fsFaults, resetFakeFs, written } from "./testing/fakeFs";

vi.mock("@tauri-apps/plugin-fs", async () => (await import("./testing/fakeFs")).fakeFs);

const { deleteYear, listEntryMonths, listEntryYears, loadEntries, pruneEmptyMonthFiles, saveEntries } =
	await import("./store");

function entry(id: string): Entry {
	return { id, activityId: "a1", startTs: Date.UTC(2026, 5, 10, 8), endTs: null, note: "", source: "manual" };
}

const file = (month: string) => `data/entries-${month}.json`;

beforeEach(resetFakeFs);

describe("saveEntries", () => {
	it("schreibt einen Monat mit Eintraegen", async () => {
		await saveEntries("2026-06", [entry("e1")]);
		expect(files.has(file("2026-06"))).toBe(true);
		expect(await loadEntries("2026-06")).toHaveLength(1);
	});

	it("loescht die Datei, wenn der letzte Eintrag entfernt wurde", async () => {
		await saveEntries("2026-06", [entry("e1")]);
		await saveEntries("2026-06", []);
		expect(files.has(file("2026-06"))).toBe(false);
	});

	it("legt fuer einen leeren Monat gar keine Datei an", async () => {
		await saveEntries("2026-07", []);
		expect(files.has(file("2026-07"))).toBe(false);
	});

	it("schreibt die Zwischendatei sichtbar, nicht als Punktdatei", async () => {
		// Der Scope des fs-Plugins ($APPDATA/**) laesst keine versteckten Dateien
		// zu - mit einem fuehrenden Punkt im Namen schiede jeder Versuch mit
		// "forbidden path", und die App schriebe dauerhaft ungeschuetzt direkt.
		await saveEntries("2026-06", [entry("e1")]);
		const versteckt = written.filter((p) => (p.split("/").pop() ?? "").startsWith("."));
		expect(versteckt).toEqual([]);
		expect(written).toContain("data/entries-2026-06.json.tmp");
	});

	it("zwei gleichzeitige Speicherungen kommen sich nicht in die Quere", async () => {
		// Gleichzeitig ist der Normalfall: die Schalter in den Einstellungen rufen
		// ihr save() ohne await. Ohne Warteschlange teilen sich beide dieselbe
		// Zwischendatei: die eine benennt sie um, der anderen fehlt sie dann, und
		// die faellt in den direkten Weg – wo sie ihren Stand ueber den der ersten
		// schreibt. Je nachdem, wer zuerst drankommt, bleibt der AELTERE stehen.
		await Promise.all([
			saveEntries("2026-06", [entry("alt")]),
			saveEntries("2026-06", [entry("neu")])
		]);
		expect(written).toEqual(["data/entries-2026-06.json.tmp", "data/entries-2026-06.json.tmp"]);
		expect((await loadEntries("2026-06")).map((e) => e.id)).toEqual(["neu"]);
		// Und die Zwischendatei bleibt nicht liegen.
		expect(files.has("data/entries-2026-06.json.tmp")).toBe(false);
	});

	it("das Leeren gewinnt gegen ein noch laufendes Speichern", async () => {
		// Der letzte Eintrag eines Monats wird entfernt, waehrend das Speichern
		// desselben Monats noch laeuft. Das Loeschen ist der kuerzere Weg und war
		// deshalb zuerst fertig – die Speicherung legte die Datei danach wieder an,
		// und der Monat stand mit dem Eintrag da, den gerade jemand entfernt hatte.
		await saveEntries("2026-06", [entry("e1")]);
		await Promise.all([saveEntries("2026-06", [entry("e2")]), saveEntries("2026-06", [])]);
		expect(files.has(file("2026-06"))).toBe(false);
	});
});

describe("listEntryMonths", () => {
	it("listet nur Monate mit Eintraegen, neueste zuerst", async () => {
		await saveEntries("2026-05", [entry("e1")]);
		await saveEntries("2026-06", [entry("e2")]);
		await saveEntries("2026-07", [entry("e3")]);
		expect(await listEntryMonths()).toEqual(["2026-07", "2026-06", "2026-05"]);
	});

	it("ignoriert fremde Dateien im Datenordner", async () => {
		await saveEntries("2026-06", [entry("e1")]);
		files.set("data/settings.json", "{}");
		files.set("data/activities.json", "[]");
		expect(await listEntryMonths()).toEqual(["2026-06"]);
	});

	it("gibt eine leere Liste zurueck, wenn es keine Eintraege gibt", async () => {
		expect(await listEntryMonths()).toEqual([]);
	});
});

describe("listEntryYears", () => {
	it("gruppiert Monate zu Jahren, neueste zuerst", async () => {
		await saveEntries("2025-11", [entry("a"), entry("b")]);
		await saveEntries("2026-01", [entry("c")]);
		await saveEntries("2026-02", [entry("d"), entry("e"), entry("f")]);
		expect(await listEntryYears()).toEqual([
			{ year: 2026, months: 2, entries: 4 },
			{ year: 2025, months: 1, entries: 2 }
		]);
	});

	it("ist leer, wenn nichts erfasst wurde", async () => {
		expect(await listEntryYears()).toEqual([]);
	});
});

describe("deleteYear", () => {
	it("loescht nur das genannte Jahr", async () => {
		await saveEntries("2025-12", [entry("a")]);
		await saveEntries("2026-01", [entry("b")]);
		await saveEntries("2026-06", [entry("c")]);

		const deleted = await deleteYear(2026);

		expect(deleted).toEqual(["2026-01", "2026-06"]);
		expect(await listEntryMonths()).toEqual(["2025-12"]);
		expect(files.has(file("2025-12"))).toBe(true);
	});

	it("laesst Aktivitaeten und Einstellungen unangetastet", async () => {
		files.set("data/settings.json", '{"bossEmail":"chef@firma.de"}');
		files.set("data/activities.json", '[{"id":"a"}]');
		await saveEntries("2026-01", [entry("a")]);

		await deleteYear(2026);

		expect(files.get("data/settings.json")).toBe('{"bossEmail":"chef@firma.de"}');
		expect(files.get("data/activities.json")).toBe('[{"id":"a"}]');
	});

	it("ist bei einem Jahr ohne Daten ein No-op", async () => {
		await saveEntries("2026-01", [entry("a")]);
		expect(await deleteYear(2019)).toEqual([]);
		expect(await listEntryMonths()).toEqual(["2026-01"]);
	});

	it("laesst ein noch laufendes Speichern die Datei nicht wieder anlegen", async () => {
		// Der Fall: jemand loescht ein Jahr, waehrend ein Speichern desselben Monats
		// noch unterwegs ist. Ging das Loeschen an der Warteschlange vorbei, schrieb
		// der anstehende Vorgang die Datei NACH dem Loeschen neu – der Cache war da
		// laengst geraeumt, der Monat lag also unsichtbar auf der Platte und stand
		// beim naechsten Start wieder in der Auswahl.
		await saveEntries("2026-01", [entry("a")]);

		const freigeben = blockWrites();
		const speichern = saveEntries("2026-01", [entry("a"), entry("b")]);
		// Das Loeschen startet, waehrend oben nachweislich noch geschrieben wird.
		const loeschen = deleteYear(2026);
		// Erst laufen lassen, bis es an der Datei ist: alles am Fake-Dateisystem ist
		// eine Microtask, ein Durchlauf der Warteschlange bringt das Loeschen also
		// bis zu seinem remove. Ohne dieses Warten stuende es beim Freigeben noch
		// beim Verzeichnis-Lesen – dann treffen die beiden gar nicht aufeinander und
		// der Test wuerde auch ohne die Warteschlange gruen.
		await new Promise((resolve) => setTimeout(resolve, 0));
		freigeben();
		await Promise.all([speichern, loeschen]);

		expect(files.has(file("2026-01"))).toBe(false);
		expect(await listEntryMonths()).toEqual([]);
	});
});

describe("pruneEmptyMonthFiles", () => {
	it("entfernt leere Altlast-Dateien frueherer Versionen", async () => {
		await saveEntries("2026-06", [entry("e1")]);
		// So sahen leere Monate vor der Umstellung auf der Platte aus.
		files.set(file("2026-03"), "[]");
		files.set(file("2025-09"), "[]");

		expect(await pruneEmptyMonthFiles()).toEqual(["2025-09", "2026-03"]);
		expect(await listEntryMonths()).toEqual(["2026-06"]);
	});

	it("laesst Monate mit Eintraegen in Ruhe", async () => {
		await saveEntries("2026-06", [entry("e1")]);
		expect(await pruneEmptyMonthFiles()).toEqual([]);
		expect(await listEntryMonths()).toEqual(["2026-06"]);
	});

	it("fasst fremde Dateien nicht an", async () => {
		files.set("data/settings.json", "{}");
		await pruneEmptyMonthFiles();
		expect(files.has("data/settings.json")).toBe(true);
	});

	it("liest Dateien, die fuer 'leer' zu gross sind, gar nicht erst", async () => {
		// Inhaltlich leer, aber weit ueber der Groessengrenze: so hat nie eine
		// Version geschrieben. Die Datei bleibt liegen, statt dass jeder Start den
		// gesamten Bestand einliest, nur um solche Faelle zu finden.
		files.set(file("2026-06"), `[${" ".repeat(200)}]`);
		expect(await pruneEmptyMonthFiles()).toEqual([]);
		expect(files.has(file("2026-06"))).toBe(true);
	});
});

describe("beschädigte Monatsdatei", () => {
	/** Halb geschriebene Datei, z.B. nach Stromausfall im Fallback-Zweig. */
	const kaputt = '[{"id":"e1","activityId":"a1","startTs":123';

	it("wird nicht als leer gelesen, sondern zur Seite gelegt", async () => {
		files.set(file("2026-06"), kaputt);
		expect(await loadEntries("2026-06")).toEqual([]);
		// Original weg, Inhalt aber unter neuem Namen erhalten.
		expect(files.has(file("2026-06"))).toBe(false);
		const abgelegt = [...files.entries()].find(([p]) => p.includes("beschaedigt"));
		expect(abgelegt?.[1]).toBe(kaputt);
	});

	it("überlebt pruneEmptyMonthFiles – der Monat wird nicht gelöscht", async () => {
		files.set(file("2026-06"), kaputt);
		await pruneEmptyMonthFiles();
		// Eine beschaedigte Datei darf prune nicht faelschlich als leer lesen und loeschen.
		expect([...files.keys()].some((p) => p.includes("beschaedigt"))).toBe(true);
	});

	it("taucht danach nicht mehr in der Monatsliste auf", async () => {
		files.set(file("2026-06"), kaputt);
		await saveEntries("2026-07", [entry("e1")]);
		await loadEntries("2026-06"); // legt die kaputte Datei ab
		expect(await listEntryMonths()).toEqual(["2026-07"]);
	});

	it("liest eine gültige Datei ganz normal", async () => {
		await saveEntries("2026-06", [entry("e1")]);
		expect(await loadEntries("2026-06")).toHaveLength(1);
		expect([...files.keys()].some((p) => p.includes("beschaedigt"))).toBe(false);
	});
});

describe("Speichern, wenn rename fehlschlägt", () => {
	// fsFaults.renameThrows macht den Fallback-Zweig von writeJson testbar - er
	// schreibt nicht-atomar.
	beforeEach(() => {
		fsFaults.renameThrows = true;
	});

	it("schreibt trotzdem eine vollständige, lesbare Datei", async () => {
		await saveEntries("2026-06", [entry("e1"), entry("e2")]);
		const roh = files.get(file("2026-06"));
		expect(roh).toBeDefined();
		expect(() => JSON.parse(roh!)).not.toThrow();
		expect(await loadEntries("2026-06")).toHaveLength(2);
	});

	it("überschreibt einen vorhandenen Monat vollständig", async () => {
		fsFaults.renameThrows = false;
		await saveEntries("2026-06", [entry("alt1"), entry("alt2"), entry("alt3")]);
		fsFaults.renameThrows = true;
		await saveEntries("2026-06", [entry("neu")]);
		const es = await loadEntries("2026-06");
		expect(es.map((e) => e.id)).toEqual(["neu"]);
	});

	it("lässt keine .tmp-Datei zurück", async () => {
		await saveEntries("2026-06", [entry("e1")]);
		expect([...files.keys()].filter((p) => p.endsWith(".tmp"))).toEqual([]);
	});
});

describe("Rundlauf", () => {
	it("erhält alle Felder unverändert", async () => {
		// Der Standard-entry() deckt nur eine Form ab; dayFraction, ein gesetztes
		// endTs und Sonderzeichen in der Notiz gingen bisher durch keinen Test.
		const voll: Entry = {
			id: "e1",
			activityId: "a1",
			startTs: Date.UTC(2026, 5, 10, 8),
			endTs: Date.UTC(2026, 5, 10, 12),
			note: 'Kunde "Müller & Co" – 50% <fertig>\nZeile zwei',
			source: "calendar",
			dayFraction: 0.5
		};
		await saveEntries("2026-06", [voll]);
		expect((await loadEntries("2026-06"))[0]).toEqual(voll);
	});
});
