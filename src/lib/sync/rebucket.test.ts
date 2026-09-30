// Monatsdateien nach einem Wechsel der Kontozeitzone.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Entry } from "../types";
import { FakeSyncServer } from "../testing/fakeSyncServer";
import { FakeDevice, onDevice } from "../testing/syncDevice";
import type { VaultKey } from "../crypto/vault";

vi.mock("@tauri-apps/plugin-fs", async () => (await import("../testing/fakeFs")).fakeFs);

const { createVaultKey, bucketFor } = await import("../crypto/vault");
const { appTimeZone, setAppTimeZone, wallToTs } = await import("../time/tz");
const { monthKey } = await import("../time/time");
const { pendingChanges, resetOutboxForTests } = await import("./outbox");
const { files, resetFakeFs, written } = await import("../testing/fakeFs");
const store = await import("../store");
const { rebucketEntries } = await import("./rebucket");

const HOME = appTimeZone();
/** +14 h: dort ist der späte Abend des 31. Juli schon der 1. August. */
const FAR = "Pacific/Kiritimati";

/** 31. Juli, 23:30 in der Heimatzone. */
const boundary = wallToTs(2026, 7, 31, 23, 30, 0, HOME);

const entry = (id: string, startTs: number, over: Partial<Entry> = {}): Entry => ({
	id,
	activityId: "a",
	startTs,
	endTs: startTs + 1800_000,
	note: "",
	source: "manual",
	...over
});

const ids = async (month: string) => (await store.loadEntries(month)).map((e) => e.id).sort();

let server: FakeSyncServer;
let key: VaultKey;

beforeEach(async () => {
	resetFakeFs();
	resetOutboxForTests();
	setAppTimeZone(HOME);
	server = new FakeSyncServer();
	key = await createVaultKey();
});

afterEach(() => {
	setAppTimeZone(HOME);
});

describe("rebucketEntries", () => {
	it("legt einen Eintrag an der Monatsgrenze in die Datei seines Monats in der neuen Zone", async () => {
		expect(monthKey(boundary)).toBe("2026-07");
		const mid = entry("mitte", wallToTs(2026, 7, 15, 12, 0, 0, HOME));
		await store.saveEntries("2026-07", [mid, entry("grenze", boundary)]);

		setAppTimeZone(FAR);
		await rebucketEntries();

		expect(await ids("2026-08")).toEqual(["grenze"]);
		expect(await ids("2026-07")).toEqual(["mitte"]);
	});

	it("räumt eine leer gewordene Monatsdatei weg", async () => {
		await store.saveEntries("2026-07", [entry("grenze", boundary)]);

		setAppTimeZone(FAR);
		await rebucketEntries();

		expect(files.has("data/entries-2026-07.json")).toBe(false);
		expect(await store.listEntryMonths()).toEqual(["2026-08"]);
	});

	it("schreibt nichts, solange die Zone dieselbe bleibt", async () => {
		await store.saveEntries("2026-07", [entry("grenze", boundary)]);
		setAppTimeZone(FAR);
		await rebucketEntries();

		const before = written.length;
		await rebucketEntries();

		expect(written.length).toBe(before);
	});

	it("behält von zwei Fassungen desselben Eintrags die jüngere", async () => {
		// Übrig aus der Zeit vor der Reparatur: die offene Fassung im alten Monat,
		// die gestoppte dort, wo die App sie nach dem Zonenwechsel hingeschrieben hat.
		setAppTimeZone(FAR);
		files.set(
			"data/entries-2026-07.json",
			JSON.stringify([entry("lauf", boundary, { endTs: null, updatedAt: 1 })])
		);
		files.set(
			"data/entries-2026-08.json",
			JSON.stringify([entry("lauf", boundary, { updatedAt: 2 })])
		);

		await rebucketEntries();

		const august = await store.loadEntries("2026-08");
		expect(august).toHaveLength(1);
		expect(august[0].endTs).toBe(boundary + 1800_000);
		expect(await store.loadEntries("2026-07")).toEqual([]);
	});

	it("führt eine vorgemerkte Änderung mit in den neuen Monat, statt eine Löschung zu senden", async () => {
		const device = new FakeDevice("rechner");
		await onDevice({ server, key }, device, async (engine) => {
			await store.saveEntries("2026-07", [entry("grenze", boundary)]);
			expect(pendingChanges().map((c) => c.month)).toEqual(["2026-07"]);

			setAppTimeZone(FAR);
			await rebucketEntries();
			expect(pendingChanges().map((c) => c.month)).toEqual(["2026-08"]);

			await engine.sync();
		});

		const row = server.rows.get("grenze");
		expect(row?.deletedAt).toBeNull();
		expect(row?.payload).not.toBeNull();
		expect(row?.bucket).toBe(await bucketFor(key, "2026-08"));
	});
});

describe("Hochladen einer Änderung, deren Eintrag den Monat gewechselt hat", () => {
	it("findet ihn im Nachbarmonat und sendet keine Löschung", async () => {
		// Ein anderes Fenster hat umsortiert, ohne die Merkliste mitzunehmen.
		const device = new FakeDevice("rechner");
		await onDevice({ server, key }, device, async (engine) => {
			await store.saveEntries("2026-07", [entry("grenze", boundary)]);
			setAppTimeZone(FAR);
			await store.remoteStore.saveEntries("2026-08", [entry("grenze", boundary)]);
			await store.remoteStore.saveEntries("2026-07", []);

			await engine.sync();
		});

		const row = server.rows.get("grenze");
		expect(row?.deletedAt).toBeNull();
		expect(row?.payload).not.toBeNull();
	});
});
