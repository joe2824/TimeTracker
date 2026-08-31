// Der Bestand, der nie einen Schreib-Haken gesehen hat - findet er den Server?
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-fs", async () => (await import("../testing/fakeFs")).fakeFs);

const { SyncEngine } = await import("./engine");
const { Api } = await import("./api");
const { createVaultKey } = await import("../crypto/vault");
const { resetOutboxForTests, startTracking, merkeUngestempeltes } = await import("./outbox");
const { files, resetFakeFs } = await import("../testing/fakeFs");
const store = await import("../store");
const { defaultSettings } = await import("../types");
import type { Activity, Entry } from "../types";
import type { LocalStore } from "./engine";
import type { ServerRecord } from "./api";

const MONAT = "2026-07";
const ts = (tag: number, stunde: number) => Date.UTC(2026, 6, tag, stunde) + 2 * 3600_000;

class FakeServer {
	rows = new Map<string, ServerRecord>();
	seq = 0;

	push(deviceId: string, records: unknown[]) {
		const accepted: { id: string; rev: number; seq: number }[] = [];
		const conflicts: { id: string; current: ServerRecord }[] = [];
		for (const raw of records as {
			id: string;
			kind: string;
			bucket?: string | null;
			baseRev: number;
			updatedAt: number;
			deletedAt?: number | null;
			payload?: string | null;
		}[]) {
			const vorhanden = this.rows.get(raw.id);
			const serverRev = vorhanden?.rev ?? 0;
			if (serverRev !== raw.baseRev) {
				conflicts.push({
					id: raw.id,
					current: vorhanden ?? {
						id: raw.id,
						kind: raw.kind,
						bucket: null,
						seq: 0,
						rev: 0,
						updatedAt: 0,
						deviceId: null,
						deletedAt: null,
						payload: null
					}
				});
				continue;
			}
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
		return { accepted, conflicts, seq: this.seq };
	}

	pull(since: number, limit = 200) {
		const alle = [...this.rows.values()].filter((r) => r.seq > since).sort((a, b) => a.seq - b.seq);
		const seite = alle.slice(0, limit);
		return {
			records: seite,
			nextSeq: seite.length > 0 ? seite[seite.length - 1].seq : since,
			hasMore: alle.length > limit
		};
	}

	arten(): Record<string, number> {
		const out: Record<string, number> = {};
		for (const r of this.rows.values()) out[r.kind] = (out[r.kind] ?? 0) + 1;
		return out;
	}

	fetchFor(deviceId: string) {
		return async (input: string, init?: RequestInit): Promise<Response> => {
			const url = new URL(input, "http://test");
			if (url.pathname === "/api/sync" && (init?.method ?? "GET") === "GET") {
				const since = Number(url.searchParams.get("since") ?? 0);
				return new Response(JSON.stringify(this.pull(since)), { status: 200 });
			}
			if (url.pathname === "/api/sync" && init?.method === "POST") {
				const body = JSON.parse(String(init.body));
				return new Response(JSON.stringify(this.push(deviceId, body.records)), { status: 200 });
			}
			return new Response(JSON.stringify({ message: "unbekannt" }), { status: 404 });
		};
	}
}

class Geraet {
	dateien = new Map<string, string>();
	state = { seq: 0 };
	constructor(readonly id: string) {}
}

let server: FakeServer;
let key: CryptoKey;

/** Etwas tun, BEVOR ein Konto verknuepft ist - also ohne Schreib-Haken. */
async function ohneKonto(g: Geraet, fn: () => Promise<void>): Promise<void> {
	resetFakeFs();
	for (const [k, v] of g.dateien) files.set(k, v);
	resetOutboxForTests();
	await fn();
	g.dateien = new Map(files);
}

/** Etwas MIT verknuepftem Konto tun. */
async function auf<T>(g: Geraet, fn: (engine: InstanceType<typeof SyncEngine>) => Promise<T>): Promise<T> {
	resetFakeFs();
	for (const [k, v] of g.dateien) files.set(k, v);
	resetOutboxForTests();
	await startTracking(g.id);

	const localStore: LocalStore = {
		entriesOfMonth: (m) => store.loadEntries(m),
		saveEntries: (m, list) => store.saveEntries(m, list),
		activities: () => store.loadActivities(),
		saveActivities: (l) => store.saveActivities(l),
		settings: () => store.loadSettings(),
		saveSettings: (s) => store.saveSettings(s)
	};
	const engine = new SyncEngine({
		api: new Api({ baseUrl: "http://test", token: "t", fetchFn: server.fetchFor(g.id) }),
		key,
		store: localStore,
		deviceId: g.id,
		state: g.state,
		saveState: async (s) => {
			g.state = s;
		}
	});
	engine.setMonthLister(() => store.listEntryMonths());

	try {
		return await fn(engine);
	} finally {
		g.dateien = new Map(files);
	}
}

/** Was AccountState bei jedem Start tut: holen, Ungestempeltes vormerken, hochladen. */
async function verknuepfe(g: Geraet, opts: { nurEigenes?: boolean } = {}): Promise<void> {
	await auf(g, async (engine) => {
		await engine.sync();
		// Was AccountState prueft, bevor es nachliest: gehoert der ungestempelte
		// Bestand ueberhaupt zu DIESEM Konto?
		const info = await store.loadDevice();
		const eigener =
			!opts.nurEigenes ||
			!info?.dataOwner ||
			!info.accountFingerprint ||
			info.dataOwner === info.accountFingerprint;
		if (eigener) await merkeUngestempeltes();
		await engine.sync();
	});
}

const aktivitaet = (id: string, name: string, color: string): Activity => ({
	id,
	name,
	color,
	sortOrder: 0,
	archived: false,
	isAbsence: false
});

const eintrag = (id: string, activityId: string): Entry => ({
	id,
	activityId,
	startTs: ts(15, 9),
	endTs: ts(15, 12),
	note: "",
	source: "manual"
});

beforeEach(async () => {
	resetFakeFs();
	server = new FakeServer();
	key = await createVaultKey();
});

describe("Nachlese: was der Schreib-Haken nie gesehen hat", () => {
	it("laedt den GESAMTEN lokalen Bestand hoch, nicht nur das danach Geaenderte", async () => {
		const rechner = new Geraet("rechner");

		// Der Mensch benutzt die App eine Weile ohne Konto.
		await ohneKonto(rechner, async () => {
			await store.saveActivities([
				aktivitaet("akt-1", "Projekt A", "#ff0000"),
				aktivitaet("akt-2", "Projekt B", "#00ff00")
			]);
			await store.saveSettings({ ...defaultSettings, hoursPerDay: 7 });
			await store.saveEntries(MONAT, [eintrag("e1", "akt-1"), eintrag("e2", "akt-2")]);
		});

		// Jetzt verknuepft er ein Konto und gleicht ab.
		await verknuepfe(rechner);

		expect(server.arten()).toEqual({ entry: 2, activity: 2, settings: 1 });
	});

	it("bringt einem zweiten Geraet Aktivitaeten UND Einstellungen mit", async () => {
		const rechner = new Geraet("rechner");
		await ohneKonto(rechner, async () => {
			await store.saveActivities([aktivitaet("akt-1", "Projekt A", "#ff0000")]);
			await store.saveSettings({ ...defaultSettings, hoursPerDay: 7 });
			await store.saveEntries(MONAT, [eintrag("e1", "akt-1")]);
		});
		await verknuepfe(rechner);

		const browser = new Geraet("browser");
		await verknuepfe(browser);

		const geladen = await auf(browser, () => store.loadActivities());
		expect(geladen.map((a) => a.name)).toEqual(["Projekt A"]);
		const s = await auf(browser, () => store.loadSettings());
		expect(s.hoursPerDay).toBe(7);
		const e = await auf(browser, () => store.loadEntries(MONAT));
		expect(e).toHaveLength(1);
	});

	it("ueberschreibt die Einstellungen des Kontos NICHT mit den Voreinstellungen des Neulings", async () => {
		const rechner = new Geraet("rechner");
		await ohneKonto(rechner, async () => {
			await store.saveSettings({ ...defaultSettings, hoursPerDay: 7 });
		});
		await verknuepfe(rechner);

		// Ein zweites Geraet, das schon einmal lief und dabei Voreinstellungen
		// weggeschrieben hat - der haeufigste Fall im Browser.
		const browser = new Geraet("browser");
		await ohneKonto(browser, async () => {
			await store.saveSettings({ ...defaultSettings });
		});
		await verknuepfe(browser);

		expect((await auf(browser, () => store.loadSettings())).hoursPerDay).toBe(7);
		// Und der Rechner bekommt seinen eigenen Wert nicht zerschossen zurueck.
		await verknuepfe(rechner);
		expect((await auf(rechner, () => store.loadSettings())).hoursPerDay).toBe(7);
	});

	it("traegt den Bestand NICHT in ein fremdes Konto", async () => {
		// Abgemeldet, neues Konto angelegt: der alte Bestand darf nicht ins neue
		// Konto wandern.
		const rechner = new Geraet("rechner");
		await ohneKonto(rechner, async () => {
			await store.saveActivities([aktivitaet("akt-1", "Geheim", "#ff0000")]);
			await store.saveEntries(MONAT, [eintrag("e1", "akt-1")]);
		});
		await verknuepfe(rechner);
		expect(server.arten()).toEqual({ entry: 1, activity: 1 });

		// Jetzt haengt dasselbe Geraet an einem ANDEREN Konto - anderer Schluessel.
		const fremd = new FakeServer();
		const alterServer = server;
		server = fremd;
		key = await createVaultKey();
		await auf(rechner, async () => {
			// Was #persistLink beim Kontowechsel vermerkt: der Bestand gehoert noch
			// dem alten Konto.
			const info = (await store.loadDevice()) ?? { id: rechner.id };
			await store.saveDevice({ ...info, accountFingerprint: "neu", dataOwner: "alt" });
		});
		await verknuepfe(rechner, { nurEigenes: true });

		expect(fremd.arten()).toEqual({});
		expect(alterServer.arten()).toEqual({ entry: 1, activity: 1 });
	});

	it("nimmt die Merkliste des vorigen Kontos nicht mit", async () => {
		// Der Stempel-Waechter allein reicht nicht: `#pushAll` liest die OUTBOX -
		// was dort vom vorigen Konto liegen blieb, ginge sonst hoch, ohne dass je
		// eine Nachlese lief.
		const rechner = new Geraet("rechner");
		await ohneKonto(rechner, async () => {
			await store.saveActivities([aktivitaet("akt-1", "Geheim", "#ff0000")]);
			await store.saveEntries(MONAT, [eintrag("e1", "akt-1")]);
		});

		// Vormerken, aber NICHT hochladen - so sieht es aus, wenn ein Abgleich
		// mittendrin abbricht oder der Server gerade weg ist.
		await auf(rechner, async () => {
			await merkeUngestempeltes();
		});
		expect(await auf(rechner, async () => (await store.loadOutbox()).length)).toBeGreaterThan(0);

		// Jetzt ein anderes Konto. Was AccountState beim Wechsel tut: Merkliste weg.
		await auf(rechner, async () => {
			await store.clearOutbox();
		});

		const fremd = new FakeServer();
		server = fremd;
		key = await createVaultKey();
		await auf(rechner, async () => {
			const info = (await store.loadDevice()) ?? { id: rechner.id };
			await store.saveDevice({ ...info, accountFingerprint: "neu", dataOwner: "alt" });
		});
		await verknuepfe(rechner, { nurEigenes: true });

		expect(fremd.arten()).toEqual({});
	});

	it("laedt spaeter Angelegtes weiterhin hoch", async () => {
		const rechner = new Geraet("rechner");
		await verknuepfe(rechner);
		await auf(rechner, async (engine) => {
			await store.saveActivities([aktivitaet("akt-9", "Danach", "#0000ff")]);
			await engine.sync();
		});
		expect(server.arten()).toEqual({ activity: 1 });
	});
});
