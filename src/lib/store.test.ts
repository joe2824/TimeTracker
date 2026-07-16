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

const { listEntryMonths, loadEntries, saveEntries } = await import("./store");

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

	it("filtert leere Altlast-Dateien aus frueheren Versionen weg", async () => {
		await saveEntries("2026-06", [entry("e1")]);
		// So sahen leere Monate vor der Umstellung auf der Platte aus.
		files.set(file("2026-03"), "[]");
		expect(await listEntryMonths()).toEqual(["2026-06"]);
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
