// Wann das Lade-Modal steht und wann nicht.
//
// Es gehoert vor den vorgezogenen Teil: da wartet jemand. Sobald nur noch die
// Historie im Hintergrund laeuft, muss es weg - sonst sperrt es die App zu,
// waehrend das Hinweisband daneben sagt, man koenne schon arbeiten.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeSyncServer } from "../testing/fakeSyncServer";
import { freshAccountEnv, restoreFetch, settled, waitFor } from "../testing/accountHarness";
import { files } from "../testing/fakeFs";
import type { ServerRecord } from "./api";

vi.mock("@tauri-apps/plugin-fs", async () => (await import("../testing/fakeFs")).fakeFs);
vi.mock("svelte-sonner", () => import("../testing/toastStub"));

const { createVaultKey } = await import("../crypto/vault");
const { account } = await import("./account.svelte");
const { app } = await import("../app.svelte");
const store = await import("../store");
const { resetOutboxForTests } = await import("./outbox");
const { monthKey, prevMonthKey } = await import("../time/time");

const OLD = "2020-03";

/** Eintraege in einem Monat, verteilt auf verschiedene Tage. */
function entriesIn(month: string, count: number, prefix: string) {
	const [year, mon] = month.split("-").map(Number);
	return Array.from({ length: count }, (_, i) => ({
		id: `${prefix}-${i}`,
		activityId: "a1",
		startTs: Date.UTC(year, mon - 1, 5 + (i % 20), 10),
		endTs: Date.UTC(year, mon - 1, 5 + (i % 20), 14),
		note: "",
		source: "manual" as const
	}));
}


/**
 * Das Geraet auf Anfang stellen: lokal leer, Stand 0, vorgezogene Monate gesetzt.
 * Der Server behaelt alles - genau die Lage nach einer frischen Verknuepfung.
 */
async function asIfFreshlyLinked(): Promise<void> {
	const info = (await store.loadDevice())!;
	for (const month of await store.listEntryMonths()) files.delete(`data/entries-${month}.json`);
	resetOutboxForTests();
	app.clearLocalData();
	await store.saveDevice({
		...info,
		seq: 0,
		priority: { seq: 0, months: [monthKey(Date.now()), prevMonthKey()] }
	});
	// Was das Einrichten angezeigt hat, gehoert nicht in die Messung.
	account.bulkSync = null;
	server.backlogCalls = 0;
}

let server: FakeSyncServer;

beforeEach(() => {
	server = freshAccountEnv();
});

afterEach(restoreFetch);

describe("Lade-Modal beim gestuften Abruf", () => {
	it("endet mit dem vorgezogenen Teil, waehrend die Historie noch laeuft", async () => {
		try {
			await account.linkWithSession("http://test", await createVaultKey(), "Ich");
			await store.saveEntries(monthKey(Date.now()), entriesIn(monthKey(Date.now()), 25, "neu"));
			await store.saveEntries(OLD, entriesIn(OLD, 3, "alt"));
			await settled();

			await asIfFreshlyLinked();
			server.hold("backlog");
			await account.init();
			await waitFor(() => server.backlogCalls > 0);

			// Die Historie haengt am Gatter - der vorgezogene Teil ist durch.
			expect((await store.loadEntries(monthKey(Date.now()))).length).toBe(25);
			expect(await store.loadEntries(OLD)).toEqual([]);
			// Also: Modal abgeschlossen, nicht mehr "wird geladen". Waere es nie
			// aufgegangen, stuende hier null - der vorgezogene Teil brachte 25
			// Eintraege, und die gehoeren gemeldet.
			expect(account.bulkSync?.phase).toBe("done");
			expect(account.bulkSync!.pulled).toBeGreaterThanOrEqual(25);

			server.release();
			await settled();
			expect((await store.loadEntries(OLD)).length).toBe(3);
		} finally {
			server.release();
			restoreFetch();
			await account.unlink();
		}
	});

	it("bleibt weg, wenn nur die Historie laeuft", async () => {
		// Der Backfill zieht 25 alte Eintraege. Ohne die Unterscheidung stuende das
		// Modal die ganze Zeit vor der App.
		try {
			await account.linkWithSession("http://test", await createVaultKey(), "Ich");
			await store.saveEntries(OLD, entriesIn(OLD, 25, "alt"));
			await settled();

			await asIfFreshlyLinked();
			server.hold("backlog");
			await account.init();
			await waitFor(() => server.backlogCalls > 0);

			// Der vorgezogene Teil brachte nur Aktivitaeten und Einstellungen -
			// nichts, wofuer sich ein Modal lohnt.
			expect(account.bulkSync).toBeNull();

			server.release();
			await waitFor(async () => (await store.loadEntries(OLD)).length === 25);
			// Die 25 alten Eintraege sind da - und zwar ohne dass die App dabei
			// hinter dem Modal stand.
			expect(account.bulkSync).toBeNull();
		} finally {
			server.release();
			restoreFetch();
			await account.unlink();
		}
	});
});
