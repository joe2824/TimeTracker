// Wann das Lade-Modal steht und wann nicht.
//
// Es gehoert vor den vorgezogenen Teil: da wartet jemand. Sobald nur noch die
// Historie im Hintergrund laeuft, muss es weg - sonst sperrt es die App zu,
// waehrend das Hinweisband daneben sagt, man koenne schon arbeiten.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { files, resetFakeFs } from "../testing/fakeFs";
import type { ServerRecord } from "./api";

vi.mock("@tauri-apps/plugin-fs", async () => (await import("../testing/fakeFs")).fakeFs);
vi.mock("svelte-sonner", () => ({
	toast: Object.assign(() => {}, {
		info() {},
		error() {},
		success() {},
		warning() {},
		loading() {},
		dismiss() {}
	})
}));

const { createVaultKey } = await import("../crypto/vault");
const { account } = await import("./account.svelte");
const { app } = await import("../app.svelte");
const store = await import("../store");
const { resetOutboxForTests } = await import("./outbox");
const { monthKey, prevMonthKey } = await import("../time");

/** Nur so viel Server, wie der gestufte Abruf anfasst - samt Zeitraum-Filter. */
class MiniServer {
	rows = new Map<string, ServerRecord>();
	seq = 0;
	/** Wie oft ein Abruf ohne Zeitraum-Filter - also die Historie - anstand. */
	backlogCalls = 0;
	/** Haelt genau diese Abrufe an, damit der Test dazwischen hinsehen kann. */
	#backlogGate: { blocked: Promise<void>; open: () => void } | null = null;

	holdBacklog(): void {
		let open!: () => void;
		const blocked = new Promise<void>((r) => (open = r));
		this.#backlogGate = { blocked, open };
	}

	releaseBacklog(): void {
		this.#backlogGate?.open();
		this.#backlogGate = null;
	}

	push(deviceId: string, records: unknown[]) {
		const accepted: { id: string; rev: number; seq: number }[] = [];
		for (const raw of records as {
			id: string;
			kind: string;
			bucket?: string | null;
			baseRev: number;
			updatedAt: number;
			deletedAt?: number | null;
			payload?: string | null;
		}[]) {
			const present = this.rows.get(raw.id);
			const serverRev = present?.rev ?? 0;
			if (serverRev !== raw.baseRev) continue;
			this.seq++;
			const rev = serverRev + 1;
			this.rows.set(raw.id, {
				id: raw.id,
				kind: raw.kind,
				bucket: raw.bucket ?? null,
				seq: this.seq,
				rev,
				updatedAt: raw.updatedAt,
				deviceId,
				deletedAt: raw.deletedAt ?? null,
				payload: raw.deletedAt ? null : (raw.payload ?? null)
			});
			accepted.push({ id: raw.id, rev, seq: this.seq });
		}
		return { accepted, conflicts: [], seq: this.seq };
	}

	pull(url: URL) {
		const since = Number(url.searchParams.get("since") ?? 0);
		const buckets = url.searchParams.getAll("bucket");
		const unbucketed = url.searchParams.get("unbucketed") === "1";
		let rows = [...this.rows.values()].filter((r) => r.seq > since);
		if (buckets.length > 0) {
			rows = rows.filter(
				(r) => (r.bucket !== null && buckets.includes(r.bucket)) || (unbucketed && r.bucket === null)
			);
		}
		rows.sort((a, b) => a.seq - b.seq);
		return {
			records: rows,
			nextSeq: rows.length > 0 ? rows[rows.length - 1].seq : since,
			hasMore: false
		};
	}

	fetchFor(deviceId: string) {
		return async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
			const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
			const url = new URL(raw, "http://test");
			const method = init?.method ?? "GET";
			if (url.pathname === "/api/sync" && method === "GET") {
				// Ohne Zeitraum-Filter ist es die Historie.
				if (url.searchParams.getAll("bucket").length === 0) {
					this.backlogCalls++;
					if (this.#backlogGate) await this.#backlogGate.blocked;
				}
				return new Response(JSON.stringify(this.pull(url)), { status: 200 });
			}
			if (url.pathname === "/api/sync" && method === "POST") {
				const body = JSON.parse(String(init!.body));
				return new Response(JSON.stringify(this.push(deviceId, body.records)), { status: 200 });
			}
			if (url.pathname === "/api/sync/buckets") {
				const buckets = [...new Set([...this.rows.values()].map((r) => r.bucket))].filter(
					(b): b is string => b !== null
				);
				return new Response(JSON.stringify({ buckets }), { status: 200 });
			}
			if (url.pathname === "/api/me") {
				return new Response(JSON.stringify({ userId: "u1", displayName: "Ich", isAdmin: false }), {
					status: 200
				});
			}
			return new Response(JSON.stringify({ message: "unbekannt" }), { status: 404 });
		};
	}
}

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

/** Warten, bis nichts mehr offen ist. */
async function settled(): Promise<void> {
	let previous = -1;
	for (let i = 0; i < 30; i++) {
		await new Promise((r) => setTimeout(r, 3));
		await account.syncNow();
		const seq = (await store.loadDevice())?.seq ?? 0;
		if (account.pending === 0 && seq === previous) return;
		previous = seq;
	}
	throw new Error("Der Abgleich kam nicht zur Ruhe");
}

async function waitFor(cond: () => boolean | Promise<boolean>): Promise<void> {
	for (let i = 0; i < 200; i++) {
		if (await cond()) return;
		await new Promise((r) => setTimeout(r, 5));
	}
	throw new Error("Bedingung trat nicht ein");
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

let server: MiniServer;
let originalFetch: typeof globalThis.fetch;

beforeEach(async () => {
	resetFakeFs();
	resetOutboxForTests();
	app.dispose();
	app.clearLocalData();
	server = new MiniServer();
	originalFetch = globalThis.fetch;
	globalThis.fetch = server.fetchFor("dieses-geraet");
});

// Symmetrisch zum Aufbau: geht ein Test unterwegs verloren, faengt der naechste
// sonst den MiniServer des vorigen als "Original" ein.
afterEach(() => {
	globalThis.fetch = originalFetch;
});

describe("Lade-Modal beim gestuften Abruf", () => {
	it("endet mit dem vorgezogenen Teil, waehrend die Historie noch laeuft", async () => {
		try {
			await account.linkWithSession("http://test", await createVaultKey(), "Ich");
			await store.saveEntries(monthKey(Date.now()), entriesIn(monthKey(Date.now()), 25, "neu"));
			await store.saveEntries(OLD, entriesIn(OLD, 3, "alt"));
			await settled();

			await asIfFreshlyLinked();
			server.holdBacklog();
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

			server.releaseBacklog();
			await settled();
			expect((await store.loadEntries(OLD)).length).toBe(3);
		} finally {
			server.releaseBacklog();
			globalThis.fetch = originalFetch;
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
			server.holdBacklog();
			await account.init();
			await waitFor(() => server.backlogCalls > 0);

			// Der vorgezogene Teil brachte nur Aktivitaeten und Einstellungen -
			// nichts, wofuer sich ein Modal lohnt.
			expect(account.bulkSync).toBeNull();

			server.releaseBacklog();
			await waitFor(async () => (await store.loadEntries(OLD)).length === 25);
			// Die 25 alten Eintraege sind da - und zwar ohne dass die App dabei
			// hinter dem Modal stand.
			expect(account.bulkSync).toBeNull();
		} finally {
			server.releaseBacklog();
			globalThis.fetch = originalFetch;
			await account.unlink();
		}
	});
});
