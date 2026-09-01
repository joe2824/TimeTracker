import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-fs", async () => (await import("../testing/fakeFs")).fakeFs);

const { files, resetFakeFs } = await import("../testing/fakeFs");
const store = await import("../store");
const { startTracking, stopTracking, pendingChanges, clearChanges, resetOutboxForTests, mergePending, SETTINGS_ID } =
	await import("./outbox");
const { defaultSettings } = await import("../types");
import type { Activity, Entry } from "../types";

const DEV = "geraet-1";

const e = (id: string, over: Partial<Entry> = {}): Entry => ({
	id,
	activityId: "a",
	startTs: 1000,
	endTs: 2000,
	note: "",
	source: "manual",
	...over
});

const act = (id: string, name: string): Activity => ({
	id,
	name,
	sortOrder: 0,
	archived: false,
	isAbsence: false
});

const onDisk = (m: string): Entry[] => JSON.parse(files.get(`data/entries-${m}.json`) ?? "[]");

beforeEach(async () => {
	resetFakeFs();
	resetOutboxForTests();
	await startTracking(DEV);
});

describe("ohne verknuepftes Konto", () => {
	it("stempelt nicht und sammelt nichts", async () => {
		stopTracking();
		resetFakeFs();
		await store.saveEntries("2026-07", [e("1")]);
		expect(onDisk("2026-07")[0].updatedAt).toBeUndefined();
		expect(onDisk("2026-07")[0].deviceId).toBeUndefined();
		expect(files.has("data/outbox.json")).toBe(false);
	});
});

describe("Eintraege", () => {
	it("stempelt einen neuen Eintrag und merkt ihn vor", async () => {
		await store.saveEntries("2026-07", [e("1")]);
		const written = onDisk("2026-07")[0];
		expect(written.deviceId).toBe(DEV);
		expect(written.updatedAt).toBeGreaterThan(0);
		expect(pendingChanges()).toEqual([
			expect.objectContaining({ kind: "entry", id: "1", month: "2026-07", deleted: false })
		]);
	});

	it("merkt eine Loeschung vor, obwohl der Datensatz weg ist", async () => {
		await store.saveEntries("2026-07", [e("1"), e("2")]);
		await clearChanges(pendingChanges());
		await store.saveEntries("2026-07", [e("2", { updatedAt: 1, deviceId: DEV })]);
		expect(pendingChanges()).toEqual([
			expect.objectContaining({ kind: "entry", id: "1", deleted: true, month: "2026-07" })
		]);
	});

	it("erfasst auch das Leeren eines ganzen Monats", async () => {
		// saveEntries loescht die Datei bei einer leeren Liste. Ohne diesen Fall
		// verschwaende der Monat lokal, ohne dass der Server je davon erfaehrt.
		await store.saveEntries("2026-07", [e("1"), e("2")]);
		await clearChanges(pendingChanges());
		await store.saveEntries("2026-07", []);
		expect(files.has("data/entries-2026-07.json")).toBe(false);
		expect(pendingChanges().map((c) => c.id).sort()).toEqual(["1", "2"]);
		expect(pendingChanges().every((c) => c.deleted)).toBe(true);
	});

	it("fasst mehrere Aenderungen am selben Eintrag zu einer zusammen", async () => {
		await store.saveEntries("2026-07", [e("1")]);
		await store.saveEntries("2026-07", [e("1", { note: "a" })]);
		await store.saveEntries("2026-07", [e("1", { note: "b" })]);
		expect(pendingChanges()).toHaveLength(1);
	});

	it("das Anlegen und Wieder-Loeschen hinterlaesst genau die Loeschung", async () => {
		await store.saveEntries("2026-07", [e("1")]);
		await store.saveEntries("2026-07", []);
		expect(pendingChanges()).toEqual([expect.objectContaining({ id: "1", deleted: true })]);
	});

	it("stempelt bei einem Speichern ohne Aenderung nicht erneut", async () => {
		await store.saveEntries("2026-07", [e("1")]);
		const firstStamp = onDisk("2026-07")[0].updatedAt;
		await clearChanges(pendingChanges());
		await store.saveEntries("2026-07", onDisk("2026-07"));
		expect(onDisk("2026-07")[0].updatedAt).toBe(firstStamp);
		expect(pendingChanges()).toEqual([]);
	});
});

describe("Aktivitaeten und Einstellungen", () => {
	it("stempelt Aktivitaeten und merkt sie vor", async () => {
		await store.saveActivities([act("a1", "Projekt")]);
		const read = await store.loadActivities();
		expect(read[0].deviceId).toBe(DEV);
		expect(pendingChanges()).toEqual([expect.objectContaining({ kind: "activity", id: "a1" })]);
	});

	it("merkt geaenderte Einstellungen als einen Datensatz vor", async () => {
		await store.saveSettings({ ...defaultSettings, hoursPerDay: 8 });
		expect(pendingChanges()).toEqual([
			expect.objectContaining({ kind: "settings", id: SETTINGS_ID })
		]);
	});

	it("gibt der Einstellungsdatei keine geliehene Id zurueck", async () => {
		// Der Vergleich braucht eine Identitaet, die Datei nicht – stuende sie
		// drin, taeuchte sie beim naechsten Laden als unbekanntes Feld auf.
		await store.saveSettings({ ...defaultSettings, hoursPerDay: 8 });
		const raw = JSON.parse(files.get("data/settings.json")!);
		expect(raw.id).toBeUndefined();
		expect(raw.updatedAt).toBeGreaterThan(0);
	});
});

describe("Outbox-Verwaltung", () => {
	it("ueberdauert einen Neustart", async () => {
		await store.saveEntries("2026-07", [e("1")]);
		resetOutboxForTests();
		await startTracking(DEV);
		expect(pendingChanges()).toEqual([expect.objectContaining({ id: "1" })]);
	});

	it("haelt eine waehrend des Hochladens dazugekommene Aenderung fest", async () => {
		// Abgehakt wird ueber Schluessel, nicht ueber Indizes: sonst risse das
		// Abhaken eine Aenderung mit weg, die es beim Hochladen noch nicht gab.
		await store.saveEntries("2026-07", [e("1")]);
		const inFlight = pendingChanges();
		await store.saveEntries("2026-07", [e("1", { updatedAt: 1, deviceId: DEV }), e("2")]);
		await clearChanges(inFlight);
		expect(pendingChanges().map((c) => c.id)).toEqual(["2"]);
	});

	it("mergePending laesst die juengste Aenderung gewinnen", () => {
		const old = [{ kind: "entry" as const, id: "1", deleted: false, at: 1 }];
		const fresh = [{ kind: "entry" as const, id: "1", deleted: true, at: 2 }];
		expect(mergePending(old, fresh)).toEqual(fresh);
	});
});
