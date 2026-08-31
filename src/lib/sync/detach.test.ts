// Entkoppeln darf keine Daten kosten.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-fs", async () => (await import("../testing/fakeFs")).fakeFs);

const { detachLocalData } = await import("./detach");
const { resetOutboxForTests, startTracking, stopTracking, pendingChanges } = await import("./outbox");
const { resetFakeFs } = await import("../testing/fakeFs");
const store = await import("../store");
import type { Activity, Entry } from "../types";

const MONTH = "2026-07";
const ts = (day: number, hour: number) => Date.UTC(2026, 6, day, hour) + 2 * 3600_000;

const entry = (id: string, over: Partial<Entry> = {}): Entry => ({
	id,
	activityId: "akt-1",
	startTs: ts(15, 9),
	endTs: ts(15, 12),
	note: "eine Notiz",
	source: "manual",
	...over
});

const activity = (id: string, over: Partial<Activity> = {}): Activity => ({
	id,
	name: "Entwicklung",
	sortOrder: 1,
	archived: false,
	isAbsence: false,
	favorite: false,
	...over
});

beforeEach(async () => {
	resetFakeFs();
	resetOutboxForTests();
	await startTracking("dieses-geraet");
});

describe("Vom Konto loesen", () => {
	it("laesst jeden Eintrag inhaltlich unveraendert", async () => {
		const before = [
			entry("e1", { updatedAt: 111, rev: 3, deviceId: "pc" }),
			entry("e2", { note: "zweite", startTs: ts(16, 8), rev: 7 })
		];
		await store.saveEntries(MONTH, before);

		await detachLocalData();

		const after = await store.loadEntries(MONTH);
		expect(after).toHaveLength(2);
		// Feld fuer Feld derselbe Eintrag - nur ohne Stempel.
		for (const [i, e] of after.entries()) {
			const { updatedAt: _u, rev: _r, deviceId: _d, ...without } = before[i];
			expect(e).toEqual(without);
		}
	});

	it("nimmt die Stempel weg", async () => {
		await store.saveEntries(MONTH, [entry("e1", { updatedAt: 111, rev: 3, deviceId: "pc" })]);
		await detachLocalData();
		const [e] = await store.loadEntries(MONTH);
		expect(e.updatedAt).toBeUndefined();
		expect(e.rev).toBeUndefined();
		expect(e.deviceId).toBeUndefined();
	});

	it("raeumt Aktivitaeten und Einstellungen genauso", async () => {
		await store.saveActivities([activity("a1", { rev: 2, updatedAt: 5, deviceId: "pc" })]);
		const s = await store.loadSettings();
		await store.saveSettings({ ...s, rev: 9, updatedAt: 5, deviceId: "pc" } as never);

		await detachLocalData();

		const [a] = await store.loadActivities();
		expect(a.name).toBe("Entwicklung");
		expect(a.rev).toBeUndefined();
		const after = (await store.loadSettings()) as unknown as Record<string, unknown>;
		expect(after.rev).toBeUndefined();
		expect(after.deviceId).toBeUndefined();
	});

	it("loescht nichts - auch keinen Monat ohne Stempel", async () => {
		await store.saveEntries("2026-05", [entry("alt")]);
		await store.saveEntries(MONTH, [entry("e1", { rev: 1 })]);

		await detachLocalData();

		expect(await store.loadEntries("2026-05")).toHaveLength(1);
		expect(await store.loadEntries(MONTH)).toHaveLength(1);
	});

	it("faesst einen Monat ohne Stempel gar nicht erst an", async () => {
		// Ein stempelfreier Monat entsteht nur VOR dem Koppeln: solange ein Konto
		// verknuepft ist, stempelt jeder Schreibvorgang. Genau so wird es hier
		// nachgestellt - erst der alte Bestand, dann die Verknuepfung.
		stopTracking();
		await store.saveEntries("2026-05", [entry("alt")]);
		await startTracking("dieses-geraet");
		await store.saveEntries(MONTH, [entry("e1", { rev: 1 })]);

		const result = await detachLocalData();

		// Nur der eine Monat wurde neu geschrieben. Bei zehn Jahren Bestand ist das
		// der Unterschied zwischen 120 Dateien und einer.
		expect(result.months).toBe(1);
	});

	it("raeumt die Outbox", async () => {
		await store.saveEntries(MONTH, [entry("e1")]);
		expect(pendingChanges().length).toBeGreaterThan(0);

		await detachLocalData();

		// Was offen war, bezog sich auf ein Konto, das dieses Geraet nicht mehr
		// hat. Stehen zu lassen hiesse: beim naechsten Koppeln wird als Erstes
		// eine Handvoll uralter Aenderungen hochgeladen.
		expect(pendingChanges()).toHaveLength(0);
	});

	it("erzeugt selbst keine neuen Vormerkungen", async () => {
		await store.saveEntries(MONTH, [entry("e1", { rev: 1 })]);
		await detachLocalData();
		// Das Abstreifen ist ein Schreibvorgang. Wuerde der Haken ihn als Aenderung
		// dieses Geraets nehmen, waere die Outbox danach wieder voll - mit genau
		// dem, was gerade weggeraeumt wurde.
		expect(pendingChanges()).toHaveLength(0);
	});
});
