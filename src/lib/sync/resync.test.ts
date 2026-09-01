// Was passiert, wenn eine Datensatzart hinzukommt, die es beim letzten Abgleich
// noch nicht gab.
//
// Der Stand `seq` laeuft ueber ALLES, was der Server hat. Eine Fassung, die eine
// Art nicht kennt, ueberspringt sie stillschweigend - und schiebt den Stand
// trotzdem weiter. Ohne einen einmaligen Nachlauf waeren die uebersprungenen
// Datensaetze fuer dieses Geraet dauerhaft unerreichbar.
import { beforeEach, describe, expect, it, vi } from "vitest";
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
const { account, RESYNC_GENERATION } = await import("./account.svelte");
const { app } = await import("../app.svelte");
const store = await import("../store");
const { resetOutboxForTests } = await import("./outbox");
const { monthKey } = await import("../time");

/** Nur so viel Server, wie der Abgleich anfasst. */
class MiniServer {
	rows = new Map<string, ServerRecord>();
	seq = 0;
	/** Ab welchem Stand jeweils abgerufen wurde - daran haengt der zweite Test. */
	pulledSince: number[] = [];
	/** Haelt den Abruf an, damit ein Test den Stand direkt nach dem Verknuepfen sieht. */
	gate: { blocked: Promise<void>; open: () => void } | null = null;

	hold() {
		let open!: () => void;
		const blocked = new Promise<void>((r) => (open = r));
		this.gate = { blocked, open };
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

	pull(since: number) {
		this.pulledSince.push(since);
		const all = [...this.rows.values()].filter((r) => r.seq > since).sort((a, b) => a.seq - b.seq);
		return { records: all, nextSeq: all.length > 0 ? all[all.length - 1].seq : since, hasMore: false };
	}

	fetchFor(deviceId: string) {
		return async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
			const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
			const url = new URL(raw, "http://test");
			const method = init?.method ?? "GET";
			if (url.pathname === "/api/sync" && method === "GET") {
				if (this.gate) await this.gate.blocked;
				const since = Number(url.searchParams.get("since") ?? 0);
				return new Response(JSON.stringify(this.pull(since)), { status: 200 });
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

const MONTH = "2026-07";

const report = () => ({
	month: MONTH,
	importedAt: Date.UTC(2026, 6, 20),
	days: [{ date: `${MONTH}-15`, firstIn: "07:30", lastOut: "16:45", hours: 7.5, flags: [] }]
});

/**
 * Warten, bis nichts mehr offen ist.
 *
 * Das Verknuepfen stoesst selbst einen Abgleich an; laeuft der noch, kommt
 * `syncNow` sofort und ohne Wirkung zurueck.
 */
async function settled(): Promise<void> {
	let previous = -1;
	for (let i = 0; i < 30; i++) {
		await new Promise((r) => setTimeout(r, 3));
		await account.syncNow();
		const seq = (await store.loadDevice())?.seq ?? 0;
		// Zweimal derselbe Stand und nichts mehr offen: jetzt liegt alles still.
		if (account.pending === 0 && seq === previous) return;
		previous = seq;
	}
	throw new Error("Der Abgleich kam nicht zur Ruhe");
}

/**
 * Ein Geraet, das mit einer Fassung ohne Reports abgeglichen hat: der Report
 * liegt beim Server, der Stand steht dahinter, lokal gibt es nichts.
 */
async function asIfUpdatedFromOldVersion(): Promise<void> {
	const info = (await store.loadDevice())!;
	// Der Merker fehlt - genau so sieht eine Datei aus, die vor dem Nachlauf
	// geschrieben wurde.
	delete (info as { resyncGeneration?: number }).resyncGeneration;
	await store.saveDevice(info);
	// Die Datei direkt weg, nicht ueber deleteTimeReport: die alte Fassung kannte
	// diese Art gar nicht, sie hat also auch keinen Loeschmarker hinterlassen.
	files.delete(`data/timereport-${MONTH}.json`);
	resetOutboxForTests();
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

describe("Monate beim Server", () => {
	it("erkennt aus den Kennungen, zu welchen Monaten es Daten gibt", async () => {
		// Waehrend der Backfill laeuft, liegt hier nur ein Teil. Die Auswahl zeigte
		// sonst ausgerechnet die Monate nicht, die man anklicken muesste.
		try {
			await account.linkWithSession("http://test", await createVaultKey(), "Ich");
			await store.saveEntries("2026-07", [
				{ id: "e1", activityId: "a1", startTs: Date.UTC(2026, 6, 15, 9), endTs: Date.UTC(2026, 6, 15, 12), note: "", source: "manual" }
			]);
			await store.saveEntries("2026-04", [
				{ id: "e2", activityId: "a1", startTs: Date.UTC(2026, 3, 10, 9), endTs: Date.UTC(2026, 3, 10, 12), note: "", source: "manual" }
			]);
			await settled();

			const months = await account.remoteMonths();
			expect(months).toContain("2026-07");
			expect(months).toContain("2026-04");
			// Ein Monat ohne Daten steht nicht drin.
			expect(months).not.toContain("2026-05");
		} finally {
			globalThis.fetch = originalFetch;
			await account.unlink();
		}
	});

	it("liefert ohne Verknuepfung nichts, statt zu fragen", async () => {
		expect(await account.remoteMonths()).toEqual([]);
	});
});

describe("Erstes Verknuepfen", () => {
	it("behaelt die vorgezogenen Monate, statt sie dem Nachlauf zu opfern", async () => {
		// Der Nachlauf setzt den Stand auf 0 zurueck. Ein frisch verknuepftes Geraet
		// steht ohnehin auf 0 - ihm dabei die Prio-Monate zu nehmen, haette den
		// gestuften Abruf bei JEDER Erstverknuepfung abgeschaltet.
		server.hold();
		try {
			await account.linkWithSession("http://test", await createVaultKey(), "Ich");

			expect((await store.loadDevice())!.priority?.months).toContain(monthKey(Date.now()));
			expect(account.backfilling).toBe(true);
		} finally {
			server.gate?.open();
			server.gate = null;
			globalThis.fetch = originalFetch;
			await account.unlink();
		}
	});
});

describe("Nachlauf fuer eine neue Datensatzart", () => {
	it("holt den uebersprungenen Report nach dem Update nach", async () => {
		try {
			await account.linkWithSession("http://test", await createVaultKey(), "Ich");
			await store.saveTimeReport(report());
			await settled();
			expect(server.rows.has(`timereport:${MONTH}`)).toBe(true);

			const seqBefore = (await store.loadDevice())!.seq;
			expect(seqBefore).toBeGreaterThan(0);

			await asIfUpdatedFromOldVersion();
			expect(await store.loadTimeReport(MONTH)).toBeNull();

			const seqBeforeUpdate = server.seq;
			await account.init();
			await settled();

			// Der Nachlauf HOLT - er schiebt nicht. Der zurueckgesetzte Stand darf
			// nicht als "frisch verknuepft" durchgehen, sonst ginge der ganze
			// Bestand ohne Not noch einmal hoch und jedes andere Geraet zoege ihn
			// hinter einer neuen Fassung wieder herunter.
			expect(server.seq).toBe(seqBeforeUpdate);

			// Ohne den Nachlauf bliebe der Stand stehen und der Report fuer immer weg.
			expect(await store.loadTimeReport(MONTH)).not.toBeNull();
			expect((await store.loadDevice())!.resyncGeneration).toBe(RESYNC_GENERATION);
		} finally {
			globalThis.fetch = originalFetch;
			await account.unlink();
		}
	});

	it("holt beim naechsten Start nicht noch einmal alles", async () => {
		try {
			await account.linkWithSession("http://test", await createVaultKey(), "Ich");
			await store.saveTimeReport(report());
			await settled();

			expect((await store.loadDevice())!.seq).toBeGreaterThan(0);

			// Ab hier zaehlt, womit der zweite Start abruft.
			server.pulledSince = [];
			resetOutboxForTests();
			await account.init();
			await settled();

			// Kein Abruf ab 0: der Merker steht schon, der Nachlauf ist erledigt.
			expect(server.pulledSince.length).toBeGreaterThan(0);
			expect(server.pulledSince).not.toContain(0);
		} finally {
			globalThis.fetch = originalFetch;
			await account.unlink();
		}
	});
});
