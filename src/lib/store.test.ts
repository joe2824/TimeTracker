import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Entry } from "./types";

// In-Memory-Dateisystem als Ersatz fuer tauri-plugin-fs.
// Schluessel = Pfad relativ zum AppData-Ordner, Wert = Dateiinhalt.
const files = new Map<string, string>();

vi.mock("@tauri-apps/plugin-fs", () => ({
	BaseDirectory: { AppData: 1 },
	exists: async (p: string) => files.has(p) || p === "data",
	mkdir: async () => {},
	readDir: async () => [...files.keys()].map((p) => ({ name: p.split("/").pop() })),
	readTextFile: async (p: string) => {
		const txt = files.get(p);
		if (txt === undefined) throw new Error(`ENOENT: ${p}`);
		return txt;
	},
	remove: async (p: string) => {
		files.delete(p);
	},
	rename: async (from: string, to: string) => {
		files.set(to, files.get(from)!);
		files.delete(from);
	},
	writeTextFile: async (p: string, txt: string) => {
		files.set(p, txt);
	}
}));

const { deleteYear, listEntryMonths, listEntryYears, loadEntries, pruneEmptyMonthFiles, saveEntries } =
	await import("./store");

function entry(id: string): Entry {
	return { id, activityId: "a1", startTs: Date.UTC(2026, 5, 10, 8), endTs: null, note: "", source: "manual" };
}

const file = (month: string) => `data/entries-${month}.json`;

beforeEach(() => files.clear());

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

	it("laesst keine .tmp-Datei zurueck", async () => {
		await saveEntries("2026-06", [entry("e1")]);
		expect([...files.keys()].filter((p) => p.includes(".tmp"))).toEqual([]);
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
		// Vorher loeschte prune die Datei, weil sie als "[]" gelesen wurde.
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
