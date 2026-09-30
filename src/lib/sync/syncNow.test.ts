// Das Konto über mehrere Aufrufer hinweg: gleichzeitiges `syncNow` und die
// Rückfragen zu Mitternachts-Teilungen über einen Neustart.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { freshAccountEnv, restoreFetch, settled } from "../testing/accountHarness";
import type { FakeSyncServer } from "../testing/fakeSyncServer";

vi.mock("@tauri-apps/plugin-fs", async () => (await import("../testing/fakeFs")).fakeFs);
vi.mock("svelte-sonner", () => import("../testing/toastStub"));
vi.mock("../platform/windows", async (importOriginal) => ({
	...(await importOriginal<typeof import("../platform/windows")>()),
	notifyDataChanged: vi.fn(async () => {})
}));

const { createVaultKey } = await import("../crypto/vault");
const { account } = await import("./account.svelte");
const { app } = await import("../app.svelte");
const store = await import("../store");
const { notifyDataChanged } = await import("../platform/windows");
const { startOfNextDay } = await import("../time/time");
const { files } = await import("../testing/fakeFs");
import { anEntry, MONTH, ts } from "../testing/fixtures";

let server: FakeSyncServer;

beforeEach(() => {
	server = freshAccountEnv();
});

afterEach(restoreFetch);

/** Alle Anfragen halten, bis `release` kommt. */
function gateFetch(): () => void {
	let release!: () => void;
	const gate = new Promise<void>((r) => (release = r));
	const inner = globalThis.fetch;
	globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
		await gate;
		return inner(...args);
	}) as typeof fetch;
	return release;
}

describe("syncNow mit mehreren Aufrufern", () => {
	it("lädt einmal neu, und keiner ist fertig, bevor neu geladen ist", async () => {
		await account.linkWithSession("http://test", await createVaultKey(), "Ich");
		await settled();
		try {
			await app.addActivity("Etwas zum Hochladen");
			const release = gateFetch();
			const reload = vi.spyOn(app, "reload");
			vi.mocked(notifyDataChanged).mockClear();
			const done: string[] = [];

			const first = account.syncNow().then(() => done.push(`erster nach ${reload.mock.calls.length}`));
			const second = account.syncNow().then(() => done.push(`zweiter nach ${reload.mock.calls.length}`));
			await new Promise((r) => setTimeout(r, 10));
			expect(done).toEqual([]);

			release();
			await Promise.all([first, second]);

			expect(reload).toHaveBeenCalledTimes(1);
			const fromSync = vi
				.mocked(notifyDataChanged)
				.mock.calls.filter(([payload]) => payload?.from === "sync");
			expect(fromSync).toHaveLength(1);
			expect(done.sort()).toEqual(["erster nach 1", "zweiter nach 1"]);
			reload.mockRestore();
		} finally {
			restoreFetch();
			await account.unlink();
		}
	});

	it("wer während eines Durchgangs dazukommt, wartet auch auf seine eigene Änderung", async () => {
		await account.linkWithSession("http://test", await createVaultKey(), "Ich");
		await settled();
		try {
			const release = gateFetch();
			const first = account.syncNow();
			// Die Runde steckt schon in ihrer ersten Anfrage - das hier kommt danach.
			await app.addActivity("Später dazugekommen");
			const id = app.activities.find((a) => a.name === "Später dazugekommen")!.id;
			const second = account.syncNow();

			release();
			await second;
			expect(server.rows.has(id)).toBe(true);
			await first;
		} finally {
			restoreFetch();
			await account.unlink();
		}
	});
});

describe("Rückfragen zu Mitternachts-Teilungen", () => {
	// Erst nach dem Verknüpfen: dann gilt die Zeitzone des Kontos, nach der auch
	// die Prüfung beim Laden rechnet.
	const ended = () => anEntry("d1", { startTs: ts(15, 9), endTs: ts(15, 10) });
	const continuation = () =>
		anEntry("d2", { startTs: startOfNextDay(ts(15, 9)), endTs: ts(16, 20), autoContinued: true });

	it("kommen nach einem Neustart wieder", async () => {
		await account.linkWithSession("http://test", await createVaultKey(), "Ich");
		await settled();
		try {
			await store.saveEntries(MONTH, [ended(), continuation()]);
			await store.saveStaleSplits([{ endedId: "d1", continuationId: "d2" }]);
			account.staleTimerSplits = [];

			await account.init();
			await settled();

			expect(account.staleTimerSplits.map((s) => [s.endedEntry.id, s.continuationEntry.id])).toEqual([
				["d1", "d2"]
			]);
		} finally {
			await account.unlink();
		}
	});

	it("eine beantwortete Frage bleibt weg", async () => {
		await account.linkWithSession("http://test", await createVaultKey(), "Ich");
		await settled();
		try {
			await store.saveEntries(MONTH, [ended(), continuation()]);
			await store.saveStaleSplits([{ endedId: "d1", continuationId: "d2" }]);
			await account.init();
			await settled();

			await account.dropStaleTimerSplit(account.staleTimerSplits[0]);

			expect(account.staleTimerSplits).toEqual([]);
			expect(await store.loadStaleSplits()).toEqual([]);
		} finally {
			await account.unlink();
		}
	});

	it("gehen beim Abmelden mit", async () => {
		await account.linkWithSession("http://test", await createVaultKey(), "Ich");
		await settled();
		await store.saveEntries(MONTH, [ended(), continuation()]);
		await store.saveStaleSplits([{ endedId: "d1", continuationId: "d2" }]);

		await account.unlink();

		expect(files.has("data/stale-splits.json")).toBe(false);
		expect(account.staleTimerSplits).toEqual([]);
	});
});
