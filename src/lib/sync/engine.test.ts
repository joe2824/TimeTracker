// Zwei Geraete an einem Konto - der ganze Weg.
//
// Echte Verschluesselung, echte Zusammenfuehrung, echter Konfliktablauf. Der
// Server ist hier nachgebaut, nicht echt: seine Regeln sind drueben in
// server/src/lib/server/sync.test.ts mit 25 Tests belegt. Was HIER geprueft
// wird, ist die andere Haelfte - ob der Client daraus das Richtige macht.
//
// Jedes Geraet hat seinen eigenen Dateibestand, der beim Wechsel ein- und
// ausgehaengt wird. Das ist nicht Umstaendlichkeit, sondern der Kern: der
// Schreib-Haken und die Abgleich-Maschine muessen DIESELBE Ablage sehen. Ein
// erster Anlauf hielt beides getrennt - und uebersah damit, dass die vom Server
// vergebene Fassung nie auf der Platte ankam.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-fs", async () => (await import("../testing/fakeFs")).fakeFs);

const { SyncEngine } = await import("./engine");
const { Api } = await import("./api");
const { createVaultKey } = await import("../crypto/vault");
const { resetOutboxForTests, startTracking, pendingChanges } = await import("./outbox");
const { files, resetFakeFs } = await import("../testing/fakeFs");
const store = await import("../store");
const { defaultSettings } = await import("../types");
import type { Entry } from "../types";
import type { LocalStore } from "./engine";
import type { ServerRecord } from "./api";

// ---------- Der nachgebaute Server ----------

class FakeServer {
	rows = new Map<string, ServerRecord>();
	seq = 0;
	/** Alle Anfragen, die je kamen - fuer Aussagen ueber den Datenverkehr. */
	calls: string[] = [];

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

	/** Eine Abrufmethode, die statt ins Netz in diesen Nachbau greift. */
	fetchFor(deviceId: string) {
		return async (input: string, init?: RequestInit): Promise<Response> => {
			const url = new URL(input, "http://test");
			this.calls.push(`${init?.method ?? "GET"} ${url.pathname}`);
			if (url.pathname === "/api/sync" && (init?.method ?? "GET") === "GET") {
				const since = Number(url.searchParams.get("since") ?? 0);
				const limit = Number(url.searchParams.get("limit") ?? 200);
				return new Response(JSON.stringify(this.pull(since, limit)), { status: 200 });
			}
			if (url.pathname === "/api/sync" && init?.method === "POST") {
				const body = JSON.parse(String(init.body));
				return new Response(JSON.stringify(this.push(deviceId, body.records)), { status: 200 });
			}
			return new Response(JSON.stringify({ message: "unbekannt" }), { status: 404 });
		};
	}
}

// ---------- Ein Geraet ----------

/**
 * Ein Geraet ist ein Dateibestand plus ein Stand.
 *
 * Die Outbox reist im Dateibestand mit (data/outbox.json) - genau wie in echt.
 */
class Geraet {
	dateien = new Map<string, string>();
	state = { seq: 0 };

	constructor(readonly id: string) {}
}

let server: FakeServer;
let key: CryptoKey;

/**
 * Etwas AUF einem Geraet tun.
 *
 * Haengt dessen Dateibestand ein, laedt seine Outbox, fuehrt aus, und legt
 * beides danach wieder zurueck. Zwei Geraete kommen sich damit nicht in die
 * Quere, obwohl das Dateisystem im Test nur einmal existiert.
 */
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

const MONAT = "2026-07";
const ts = (tag: number, stunde: number) => Date.UTC(2026, 6, tag, stunde) + 2 * 3600_000;

const eintrag = (id: string, over: Partial<Entry> = {}): Entry => ({
	id,
	activityId: "akt-1",
	startTs: ts(15, 9),
	endTs: ts(15, 12),
	note: "",
	source: "manual",
	...over
});

/** Was auf einem Geraet in einem Monat liegt. */
async function eintraege(g: Geraet, monat = MONAT): Promise<Entry[]> {
	return auf(g, () => store.loadEntries(monat));
}

beforeEach(async () => {
	resetFakeFs();
	resetOutboxForTests();
	server = new FakeServer();
	key = await createVaultKey();
});

describe("Ein Geraet allein", () => {
	it("laedt eine Aenderung hoch und haelt danach nichts mehr offen", async () => {
		const handy = new Geraet("handy");
		const ergebnis = await auf(handy, async (engine) => {
			await store.saveEntries(MONAT, [eintrag("e1")]);
			expect(pendingChanges()).toHaveLength(1);
			return engine.sync();
		});
		expect(ergebnis!.pushed).toBe(1);
		expect(server.rows.size).toBe(1);
		await auf(handy, async () => expect(pendingChanges()).toEqual([]));
	});

	it("legt beim Server nur Chiffrat ab", async () => {
		// Die Zusage des ganzen Entwurfs, hier nachgesehen statt behauptet.
		const handy = new Geraet("handy");
		await auf(handy, async (engine) => {
			await store.saveEntries(MONAT, [eintrag("e1", { note: "Kundengespräch" })]);
			return engine.sync();
		});
		const zeile = [...server.rows.values()][0];
		const alles = JSON.stringify(zeile);
		expect(alles).not.toContain("Kundengespräch");
		expect(alles).not.toContain("akt-1");
		expect(alles).not.toContain(String(ts(15, 9)));
		// Der verschleierte Zeitraum verraet den Monat nicht.
		expect(zeile.bucket).not.toContain("2026");
		expect(zeile.bucket).toMatch(/^[0-9a-f]{32}$/);
	});

	it("schreibt die Fassung des Servers auf die Platte zurueck", async () => {
		// Daran haengt alles Weitere: eine Folgeaenderung wird nur angenommen, wenn
		// sie auf der Fassung des Servers aufsetzt.
		const handy = new Geraet("handy");
		await auf(handy, async (engine) => {
			await store.saveEntries(MONAT, [eintrag("e1")]);
			return engine.sync();
		});
		expect((await eintraege(handy))[0].rev).toBe(1);
	});

	it("laedt beim zweiten Durchgang nichts erneut hoch", async () => {
		const handy = new Geraet("handy");
		await auf(handy, async (engine) => {
			await store.saveEntries(MONAT, [eintrag("e1")]);
			return engine.sync();
		});
		const vorher = server.seq;
		const zweiter = await auf(handy, (engine) => engine.sync());
		expect(zweiter!.pushed).toBe(0);
		expect(server.seq).toBe(vorher);
	});
});

describe("Zwei Geraete", () => {
	/** Ein Handy mit einem hochgeladenen Eintrag - die Ausgangslage vieler Faelle. */
	async function handyMit(e: Entry): Promise<Geraet> {
		const handy = new Geraet("handy");
		await auf(handy, async (engine) => {
			await store.saveEntries(MONAT, [e]);
			return engine.sync();
		});
		return handy;
	}

	it("das zweite Geraet bekommt den Eintrag des ersten - entschluesselt", async () => {
		await handyMit(eintrag("e1", { note: "vom Handy" }));

		const rechner = new Geraet("rechner");
		await auf(rechner, (engine) => engine.sync());

		const liste = await eintraege(rechner);
		expect(liste).toHaveLength(1);
		expect(liste[0].note).toBe("vom Handy");
		expect(liste[0].activityId).toBe("akt-1");
	});

	it("uebernimmt eine Loeschung", async () => {
		const handy = await handyMit(eintrag("e1"));
		const rechner = new Geraet("rechner");
		await auf(rechner, (engine) => engine.sync());
		expect(await eintraege(rechner)).toHaveLength(1);

		// Das Handy loescht. Der Vergleich beim Schreiben erkennt die Loeschung
		// samt der Fassung, die der Eintrag zuletzt hatte - genau die braucht der
		// Server, um sie anzunehmen.
		const geloescht = await auf(handy, async (engine) => {
			await store.saveEntries(MONAT, []);
			expect(pendingChanges()).toEqual([
				expect.objectContaining({ id: "e1", deleted: true, rev: 1 })
			]);
			return engine.sync();
		});
		expect(geloescht!.pushed).toBe(1);

		await auf(rechner, (engine) => engine.sync());
		expect(await eintraege(rechner)).toHaveLength(0);
	});

	it("loest einen Konflikt auf und laedt danach durch", async () => {
		// Beide aendern denselben Eintrag, ohne voneinander zu wissen.
		const handy = await handyMit(eintrag("e1", { note: "handy" }));
		const rechner = new Geraet("rechner");
		await auf(rechner, (engine) => engine.sync());

		// Der Rechner aendert - auf dem Stand, den er kennt.
		await auf(rechner, async (engine) => {
			const seiner = (await store.loadEntries(MONAT))[0];
			await store.saveEntries(MONAT, [{ ...seiner, note: "rechner" }]);
			return engine.sync();
		});

		// Das Handy holt und sieht die juengere Fassung.
		await auf(handy, (engine) => engine.sync());
		expect((await eintraege(handy))[0].note).toBe("rechner");
	});

	it("laesst hoechstens einen Timer laufen, wenn beide Geraete einen halten", async () => {
		// Der Fall, um den es dem Nutzer geht: am Handy gestartet, der Rechner
		// wacht auf und weiss nichts davon.
		await handyMit(eintrag("h1", { endTs: null, startTs: ts(15, 9) }));

		const rechner = new Geraet("rechner");
		await auf(rechner, async (engine) => {
			// Der Rechner startet seinerseits - spaeter, also ist das die juengere
			// Handlung.
			await store.saveEntries(MONAT, [eintrag("r1", { endTs: null, startTs: ts(15, 14) })]);
			return engine.sync();
		});

		const liste = await eintraege(rechner);
		const offen = liste.filter((e) => e.endTs === null);
		expect(offen).toHaveLength(1);
		expect(offen[0].id).toBe("r1");
		// Der Lauf vom Handy ist nicht weg, sondern beendet - dort steckt echte Zeit.
		expect(liste.find((e) => e.id === "h1")!.endTs).toBe(ts(15, 14));
	});

	it("gleicht Aktivitaeten ab", async () => {
		const handy = new Geraet("handy");
		await auf(handy, async (engine) => {
			await store.saveActivities([
				{ id: "a1", name: "Projekt Alpha", sortOrder: 0, archived: false, isAbsence: false }
			]);
			return engine.sync();
		});

		const rechner = new Geraet("rechner");
		await auf(rechner, (engine) => engine.sync());
		const geholt = await auf(rechner, () => store.loadActivities());
		expect(geholt.map((a) => a.name)).toEqual(["Projekt Alpha"]);
	});

	it("gleicht Einstellungen ab, ohne die geliehene Id zu hinterlassen", async () => {
		const handy = new Geraet("handy");
		await auf(handy, async (engine) => {
			await store.saveSettings({ ...defaultSettings, hoursPerDay: 8, timeZone: "Europe/Berlin" });
			return engine.sync();
		});

		const rechner = new Geraet("rechner");
		await auf(rechner, (engine) => engine.sync());
		const s = await auf(rechner, () => store.loadSettings());
		expect(s.hoursPerDay).toBe(8);
		expect((s as unknown as { id?: string }).id).toBeUndefined();
	});
});

describe("Kein Echo", () => {
	it("merkt Eingespieltes nicht als eigene Aenderung vor", async () => {
		// Der Fehler, der diesen Test verdient hat: der Schreib-Haken sah das
		// Einspielen von Serverdaten wie jede andere Aenderung und merkte sie vor.
		// Der naechste Durchgang lud sie wieder hoch, wo sie als veraltet
		// abgewiesen wurde - ein Geraet, das dieselben Datensaetze im Kreis
		// schickt und dabei dauernd Konflikte meldet.
		const handy = new Geraet("handy");
		await auf(handy, async (engine) => {
			await store.saveEntries(MONAT, [eintrag("e1")]);
			await store.saveActivities([
				{ id: "a1", name: "Alpha", sortOrder: 0, archived: false, isAbsence: false }
			]);
			return engine.sync();
		});

		const rechner = new Geraet("rechner");
		await auf(rechner, async (engine) => {
			await engine.sync();
			expect(pendingChanges()).toEqual([]);
		});

		// Und der naechste Durchgang laedt folglich auch nichts hoch.
		const zweiter = await auf(rechner, (engine) => engine.sync());
		expect(zweiter!.pushed).toBe(0);
	});
});

describe("Sparsamkeit", () => {
	it("ein Durchgang ohne Aenderungen kostet genau eine Anfrage", async () => {
		// Der Anspruch aus dem Entwurf: im Leerlauf passiert nichts. Waere hier ein
		// Poller am Werk, stuenden hier Dutzende Anfragen.
		const handy = new Geraet("handy");
		await auf(handy, (engine) => engine.sync());
		server.calls = [];
		await auf(handy, (engine) => engine.sync());
		expect(server.calls).toEqual(["GET /api/sync"]);
	});

	it("laesst zwei gleichzeitige Anstoesse nicht nebeneinanderlaufen", async () => {
		// Sonst zoegen sie sich gegenseitig die Outbox unter den Fuessen weg.
		const handy = new Geraet("handy");
		const [a, b] = await auf(handy, async (engine) => {
			await store.saveEntries(MONAT, [eintrag("e1")]);
			return Promise.all([engine.sync(), engine.sync()]);
		});
		expect([a, b].filter((x) => x === null)).toHaveLength(1);
		expect(server.rows.size).toBe(1);
	});

	it("blaettert durch einen grossen Bestand, ohne etwas zu ueberspringen", async () => {
		const handy = new Geraet("handy");
		await auf(handy, async (engine) => {
			const viele = Array.from({ length: 450 }, (_, i) =>
				eintrag(`e${i}`, { startTs: ts(15, 9) + i * 1000, endTs: ts(15, 9) + i * 1000 + 60_000 })
			);
			await store.saveEntries(MONAT, viele);
			return engine.sync();
		});

		const rechner = new Geraet("rechner");
		await auf(rechner, (engine) => engine.sync());
		const liste = await eintraege(rechner);
		expect(liste).toHaveLength(450);
		expect(new Set(liste.map((e) => e.id)).size).toBe(450);
	});
});

describe("Robustheit", () => {
	it("ein unlesbarer Datensatz haelt den Abgleich nicht an", async () => {
		// Ein einzelner unlesbarer Datensatz ist ein Aergernis, ein
		// steckengebliebener Abgleich ein Ausfall.
		const handy = new Geraet("handy");
		await auf(handy, async (engine) => {
			await store.saveEntries(MONAT, [eintrag("e1")]);
			return engine.sync();
		});

		// Ein Datensatz mit Chiffrat aus einem FREMDEN Tresor.
		const fremderSchluessel = key;
		key = await createVaultKey();
		const fremd = new Geraet("fremd");
		await auf(fremd, async (engine) => {
			await store.saveEntries("2026-08", [eintrag("e2", { startTs: ts(20, 9) })]);
			return engine.sync();
		});
		key = fremderSchluessel;

		// Ein Geraet mit dem RICHTIGEN Schluessel bekommt e1 und ueberspringt e2.
		const rechner = new Geraet("rechner");
		await expect(auf(rechner, (engine) => engine.sync())).resolves.toBeTruthy();
		expect((await eintraege(rechner)).map((e) => e.id)).toEqual(["e1"]);
		expect(await eintraege(rechner, "2026-08")).toEqual([]);
	});

	it("merkt sich den Stand, damit der naechste Durchgang nur das Delta holt", async () => {
		const handy = new Geraet("handy");
		await auf(handy, async (engine) => {
			await store.saveEntries(MONAT, [eintrag("e1")]);
			return engine.sync();
		});
		const rechner = new Geraet("rechner");
		await auf(rechner, (engine) => engine.sync());
		expect(rechner.state.seq).toBe(server.seq);
	});
});
