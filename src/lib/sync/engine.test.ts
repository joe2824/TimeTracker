// Zwei Geraete an einem Konto - der ganze Weg.
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
			const present = this.rows.get(raw.id);
			const serverRev = present?.rev ?? 0;
			if (serverRev !== raw.baseRev) {
				conflicts.push({
					id: raw.id,
					current: present ?? {
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
		const all = [...this.rows.values()].filter((r) => r.seq > since).sort((a, b) => a.seq - b.seq);
		const page = all.slice(0, limit);
		return {
			records: page,
			nextSeq: page.length > 0 ? page[page.length - 1].seq : since,
			hasMore: all.length > limit
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

/** Ein Geraet ist ein Dateibestand plus ein Stand. */
class Device {
	files = new Map<string, string>();
	state = { seq: 0 };

	constructor(readonly id: string) {}
}

let server: FakeServer;
let key: CryptoKey;

/** Etwas AUF einem Geraet tun. */
async function on<T>(g: Device, fn: (engine: InstanceType<typeof SyncEngine>) => Promise<T>): Promise<T> {
	resetFakeFs();
	for (const [k, v] of g.files) files.set(k, v);
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
		g.files = new Map(files);
	}
}

const MONTH = "2026-07";
const ts = (day: number, hour: number) => Date.UTC(2026, 6, day, hour) + 2 * 3600_000;

const entry = (id: string, over: Partial<Entry> = {}): Entry => ({
	id,
	activityId: "akt-1",
	startTs: ts(15, 9),
	endTs: ts(15, 12),
	note: "",
	source: "manual",
	...over
});

/**
 * Warten, bis die Uhr weiterspringt.
 *
 * Bei gleichem `updatedAt` entscheidet die Geraetekennung statt der Reihenfolge -
 * derselbe Test fiele sonst mal so und mal so aus.
 */
async function afterwards(): Promise<void> {
	const now = Date.now();
	while (Date.now() === now) await new Promise((r) => setTimeout(r, 1));
}

/** Was auf einem Geraet in einem Monat liegt. */
async function entries(g: Device, month = MONTH): Promise<Entry[]> {
	return on(g, () => store.loadEntries(month));
}

beforeEach(async () => {
	resetFakeFs();
	resetOutboxForTests();
	server = new FakeServer();
	key = await createVaultKey();
});

describe("Ein Geraet allein", () => {
	it("laedt eine Aenderung hoch und haelt danach nichts mehr offen", async () => {
		const phone = new Device("handy");
		const result = await on(phone, async (engine) => {
			await store.saveEntries(MONTH, [entry("e1")]);
			expect(pendingChanges()).toHaveLength(1);
			return engine.sync();
		});
		expect(result!.pushed).toBe(1);
		expect(server.rows.size).toBe(1);
		await on(phone, async () => expect(pendingChanges()).toEqual([]));
	});

	it("legt beim Server nur Chiffrat ab", async () => {
		// Die Zusage des ganzen Entwurfs, hier nachgesehen statt behauptet.
		const phone = new Device("handy");
		await on(phone, async (engine) => {
			await store.saveEntries(MONTH, [entry("e1", { note: "Kundengespräch" })]);
			return engine.sync();
		});
		const line = [...server.rows.values()][0];
		const everything = JSON.stringify(line);
		expect(everything).not.toContain("Kundengespräch");
		expect(everything).not.toContain("akt-1");
		expect(everything).not.toContain(String(ts(15, 9)));
		// Der verschleierte Zeitraum verraet den Monat nicht.
		expect(line.bucket).not.toContain("2026-08");
		expect(line.bucket).toMatch(/^[0-9a-f]{32}$/);
	});

	it("schreibt die Fassung des Servers auf die Platte zurueck", async () => {
		// Daran haengt alles Weitere: eine Folgeaenderung wird nur angenommen, wenn
		// sie auf der Fassung des Servers aufsetzt.
		const phone = new Device("handy");
		await on(phone, async (engine) => {
			await store.saveEntries(MONTH, [entry("e1")]);
			return engine.sync();
		});
		expect((await entries(phone))[0].rev).toBe(1);
	});

	it("laedt beim zweiten Durchgang nichts erneut hoch", async () => {
		const phone = new Device("handy");
		await on(phone, async (engine) => {
			await store.saveEntries(MONTH, [entry("e1")]);
			return engine.sync();
		});
		const before = server.seq;
		const secondOne = await on(phone, (engine) => engine.sync());
		expect(secondOne!.pushed).toBe(0);
		expect(server.seq).toBe(before);
	});
});

describe("Zwei Geraete", () => {
	/** Ein Handy mit einem hochgeladenen Eintrag - die Ausgangslage vieler Faelle. */
	async function phoneWith(e: Entry): Promise<Device> {
		const phone = new Device("handy");
		await on(phone, async (engine) => {
			await store.saveEntries(MONTH, [e]);
			return engine.sync();
		});
		return phone;
	}

	it("das zweite Geraet bekommt den Eintrag des ersten - entschluesselt", async () => {
		await phoneWith(entry("e1", { note: "vom Handy" }));

		const desktop = new Device("rechner");
		await on(desktop, (engine) => engine.sync());

		const list = await entries(desktop);
		expect(list).toHaveLength(1);
		expect(list[0].note).toBe("vom Handy");
		expect(list[0].activityId).toBe("akt-1");
	});

	it("uebernimmt eine Loeschung", async () => {
		const phone = await phoneWith(entry("e1"));
		const desktop = new Device("rechner");
		await on(desktop, (engine) => engine.sync());
		expect(await entries(desktop)).toHaveLength(1);

		// Das Handy loescht. Der Vergleich beim Schreiben erkennt die Loeschung
		// samt der Fassung, die der Eintrag zuletzt hatte - genau die braucht der
		// Server, um sie anzunehmen.
		await afterwards();
		const deleted = await on(phone, async (engine) => {
			await store.saveEntries(MONTH, []);
			expect(pendingChanges()).toEqual([
				expect.objectContaining({ id: "e1", deleted: true, rev: 1 })
			]);
			return engine.sync();
		});
		expect(deleted!.pushed).toBe(1);

		await on(desktop, (engine) => engine.sync());
		expect(await entries(desktop)).toHaveLength(0);
	});

	it("loest einen Konflikt auf und laedt danach durch", async () => {
		// Beide aendern denselben Eintrag, ohne voneinander zu wissen.
		const phone = await phoneWith(entry("e1", { note: "handy" }));
		const desktop = new Device("rechner");
		await on(desktop, (engine) => engine.sync());

		// Der Rechner aendert - auf dem Stand, den er kennt, und nachweislich spaeter.
		await afterwards();
		await on(desktop, async (engine) => {
			const theirs = (await store.loadEntries(MONTH))[0];
			await store.saveEntries(MONTH, [{ ...theirs, note: "rechner" }]);
			return engine.sync();
		});

		// Das Handy holt und sieht die juengere Fassung.
		await on(phone, (engine) => engine.sync());
		expect((await entries(phone))[0].note).toBe("rechner");
	});

	it("laesst hoechstens einen Timer laufen, wenn beide Geraete einen halten", async () => {
		// Der Fall, um den es dem Nutzer geht: am Handy gestartet, der Rechner
		// wacht auf und weiss nichts davon.
		await phoneWith(entry("h1", { endTs: null, startTs: ts(15, 9) }));

		const desktop = new Device("rechner");
		await on(desktop, async (engine) => {
			// Der Rechner startet seinerseits - spaeter, also ist das die juengere
			// Handlung.
			await store.saveEntries(MONTH, [entry("r1", { endTs: null, startTs: ts(15, 14) })]);
			return engine.sync();
		});

		const list = await entries(desktop);
		const open = list.filter((e) => e.endTs === null);
		expect(open).toHaveLength(1);
		expect(open[0].id).toBe("r1");
		// Der Lauf vom Handy ist nicht weg, sondern beendet - dort steckt echte Zeit.
		expect(list.find((e) => e.id === "h1")!.endTs).toBe(ts(15, 14));
	});

	it("gleicht Aktivitaeten ab", async () => {
		const phone = new Device("handy");
		await on(phone, async (engine) => {
			await store.saveActivities([
				{ id: "a1", name: "Projekt Alpha", sortOrder: 0, archived: false, isAbsence: false }
			]);
			return engine.sync();
		});

		const desktop = new Device("rechner");
		await on(desktop, (engine) => engine.sync());
		const fetched = await on(desktop, () => store.loadActivities());
		expect(fetched.map((a) => a.name)).toEqual(["Projekt Alpha"]);
	});

	it("gleicht Einstellungen ab, ohne die geliehene Id zu hinterlassen", async () => {
		const phone = new Device("handy");
		await on(phone, async (engine) => {
			await store.saveSettings({ ...defaultSettings, hoursPerDay: 8, timeZone: "Europe/Berlin" });
			return engine.sync();
		});

		const desktop = new Device("rechner");
		await on(desktop, (engine) => engine.sync());
		const s = await on(desktop, () => store.loadSettings());
		expect(s.hoursPerDay).toBe(8);
		expect((s as unknown as { id?: string }).id).toBeUndefined();
	});

	it("gleicht Pomodoro-Einstellungen und laufenden Timer korrekt ab", async () => {
		const phone = new Device("handy");
		await on(phone, async (engine) => {
			await store.saveSettings({
				...defaultSettings,
				pomodoroEnabled: true,
				pomodoroMin: 25,
				pomodoroBreakMin: 5
			});
			await store.saveEntries("2026-07", [
				entry("timer1", { startTs: ts(15, 9), endTs: null })
			]);
			return engine.sync();
		});

		const desktop = new Device("rechner");
		await on(desktop, (engine) => engine.sync());
		const s = await on(desktop, () => store.loadSettings());
		const entries = await on(desktop, () => store.loadEntries("2026-07"));

		expect(s.pomodoroEnabled).toBe(true);
		expect(s.pomodoroMin).toBe(25);
		expect(s.pomodoroBreakMin).toBe(5);
		expect(entries).toHaveLength(1);
		expect(entries[0].id).toBe("timer1");
		expect(entries[0].endTs).toBeNull();
	});
});

/** Ein Zeitstempel im Folgemonat - fuer alles, was ueber die Monatsgrenze geht. */
const tsAug = (day: number, hour: number) => Date.UTC(2026, 7, day, hour) + 2 * 3600_000;

/** Eine Loeschung beim Server nachstellen, ohne ein Geraet dafuer zu bemuehen. */
function tombstone(id: string, rev: number): void {
	server.seq++;
	const old = server.rows.get(id);
	const when = Date.now() + 60_000;
	server.rows.set(id, {
		id,
		kind: "entry",
		bucket: old?.bucket ?? null,
		seq: server.seq,
		rev,
		updatedAt: when,
		deviceId: "handy",
		deletedAt: when,
		payload: null
	});
}

describe("Ueber Monatsgrenzen hinweg", () => {
	it("verschiebt einen umdatierten Eintrag, statt ihn zu verdoppeln", async () => {
		// Der Weg, den updateEntry geht, wenn jemand das Datum ueber den
		// Monatswechsel zieht: der alte Monat wird ohne ihn gespeichert, der neue
		// mit ihm. In der Outbox bleibt davon EINE Aenderung stehen (die spaetere
		// gewinnt), der Server sieht also nie eine Loeschung - das andere Geraet
		// muss den Umzug am neuen Startzeitpunkt selbst erkennen.
		const phone = new Device("handy");
		await on(phone, async (engine) => {
			await store.saveEntries(MONTH, [entry("e1")]);
			return engine.sync();
		});
		const desktop = new Device("rechner");
		await on(desktop, (engine) => engine.sync());
		expect(await entries(desktop, MONTH)).toHaveLength(1);

		await on(phone, async (engine) => {
			const theirs = (await store.loadEntries(MONTH))[0];
			await store.saveEntries(MONTH, []);
			await store.saveEntries("2026-08", [
				{ ...theirs, startTs: tsAug(3, 9), endTs: tsAug(3, 12) }
			]);
			return engine.sync();
		});

		await on(desktop, (engine) => engine.sync());
		expect((await entries(desktop, "2026-08")).map((e) => e.id)).toEqual(["e1"]);
		// Und NICHT zusaetzlich im alten Monat: sonst zaehlte dieselbe Stunde zweimal.
		expect(await entries(desktop, MONTH)).toEqual([]);
	});

	it("laesst hoechstens einen Timer laufen, auch ueber zwei Monate", async () => {
		// Am Monatsende am Handy gestartet, im naechsten Monat am Rechner noch
		// einmal. Zwei laufende Timer in zwei Dateien - monatsweise betrachtet stand
		// in jeder genau einer, und beide zaehlten weiter.
		const phone = new Device("handy");
		await on(phone, async (engine) => {
			await store.saveEntries(MONTH, [entry("h1", { startTs: ts(30, 10), endTs: null })]);
			return engine.sync();
		});

		const desktop = new Device("rechner");
		await on(desktop, async (engine) => {
			await store.saveEntries("2026-08", [entry("r1", { startTs: tsAug(2, 10), endTs: null })]);
			return engine.sync();
		});

		const july = await entries(desktop, MONTH);
		const august = await entries(desktop, "2026-08");
		const open = [...july, ...august].filter((e) => e.endTs === null);
		expect(open.map((e) => e.id)).toEqual(["r1"]);
		// Der Lauf vom Handy ist nicht weg, sondern beendet - dort steckt echte Zeit.
		expect(july.find((e) => e.id === "h1")!.endTs).toBe(tsAug(2, 10));
	});

	it("findet den Monat eines Grabsteins, den es beim Start noch nicht gab", async () => {
		// Ein Programm, das laeuft und laeuft. Die Monatsliste darf ihm nicht
		// einfrieren: sonst faende die Loeschung ihren Monat nicht, wuerde still
		// verworfen - und `seq` liefe trotzdem weiter. Endgueltig verloren.
		const phone = new Device("handy");
		await on(phone, async (engine) => {
			await store.saveEntries(MONTH, [entry("e1")]);
			return engine.sync();
		});
		// Ein Grabstein fuer etwas, das der Rechner nie hatte. Er ist der Grund,
		// weshalb die Monatsliste im ersten Durchgang ueberhaupt gezogen wird - zu
		// einem Zeitpunkt, an dem es noch keine Monatsdatei gibt.
		tombstone("nie-gesehen", 1);

		const desktop = new Device("rechner");
		await on(desktop, async (engine) => {
			await engine.sync();
			expect(await store.loadEntries(MONTH)).toHaveLength(1);

			tombstone("e1", 2);
			await engine.sync();
			expect(await store.loadEntries(MONTH)).toEqual([]);
		});
	});

	it("ein geloeschtes Jahr kommt beim naechsten Durchgang nicht zurueck", async () => {
		const phone = new Device("handy");
		await on(phone, async (engine) => {
			await store.saveEntries("2025-03", [
				entry("alt", { startTs: Date.UTC(2025, 2, 4, 9), endTs: Date.UTC(2025, 2, 4, 12) })
			]);
			return engine.sync();
		});
		const desktop = new Device("rechner");
		await on(desktop, (engine) => engine.sync());
		expect(await entries(desktop, "2025-03")).toHaveLength(1);

		await on(phone, async (engine) => {
			expect(await store.deleteYear(2025)).toEqual(["2025-03"]);
			// Das Loeschen muss durch den Haken gegangen sein, sonst weiss der
			// Abgleich nichts davon.
			expect(pendingChanges()).toEqual([
				expect.objectContaining({ kind: "entry", id: "alt", deleted: true })
			]);
			return engine.sync();
		});

		// Der naechste Durchgang holt es nicht wieder herunter ...
		await on(phone, (engine) => engine.sync());
		expect(await entries(phone, "2025-03")).toEqual([]);
		// ... und das andere Geraet raeumt mit auf.
		await on(desktop, (engine) => engine.sync());
		expect(await entries(desktop, "2025-03")).toEqual([]);
	});
});

describe("Was der Mensch erfahren muss", () => {
	it("zaehlt eine unterlegene eigene Aenderung auch beim Konflikt-Aufloesen", async () => {
		// Der haeufigste Weg in einen verlorenen Eigenstand fuehrt genau hier
		// entlang: die eigene Aenderung stoesst auf einen Konflikt, und beim
		// Aufloesen gewinnt der Server. Bliebe die Zahl dort liegen, stuende am Ende
		// "abgeglichen" da - ohne ein Wort darueber, dass etwas ueberschrieben wurde.
		const phone = new Device("handy");
		await on(phone, async (engine) => {
			await store.saveEntries(MONTH, [entry("e1", { note: "handy" })]);
			return engine.sync();
		});
		const desktop = new Device("rechner");
		await on(desktop, (engine) => engine.sync());

		// Das Handy aendert und laedt hoch - und zwar nachweislich spaeter, damit
		// der Wettstreit nicht an einer Millisekunde haengt.
		await on(phone, async (engine) => {
			const theirs = (await store.loadEntries(MONTH))[0];
			await store.saveEntries(MONTH, [{ ...theirs, note: "handy zwei" }]);
			return engine.sync();
		});
		const line = server.rows.get("e1")!;
		server.rows.set("e1", { ...line, updatedAt: Date.now() + 60_000 });

		// Der Rechner aendert auf seinem alten Stand und laeuft in den Konflikt.
		const result = await on(desktop, async (engine) => {
			const theirs = (await store.loadEntries(MONTH))[0];
			await store.saveEntries(MONTH, [{ ...theirs, note: "rechner" }]);
			return engine.sync();
		});

		expect(result!.lostEdits).toBe(1);
		expect((await entries(desktop))[0].note).toBe("handy zwei");
	});
});

describe("Kein Echo", () => {
	it("merkt Eingespieltes nicht als eigene Aenderung vor", async () => {
		// Ohne diese Wache saehe der Schreib-Haken das Einspielen von Serverdaten
		// wie jede andere Aenderung und merkte sie vor - der naechste Durchgang
		// luede sie wieder hoch, wo sie als veraltet abgewiesen wuerde: ein
		// Geraet, das dieselben Datensaetze im Kreis schickt.
		const phone = new Device("handy");
		await on(phone, async (engine) => {
			await store.saveEntries(MONTH, [entry("e1")]);
			await store.saveActivities([
				{ id: "a1", name: "Alpha", sortOrder: 0, archived: false, isAbsence: false }
			]);
			return engine.sync();
		});

		const desktop = new Device("rechner");
		await on(desktop, async (engine) => {
			await engine.sync();
			expect(pendingChanges()).toEqual([]);
		});

		// Und der naechste Durchgang laedt folglich auch nichts hoch.
		const secondOne = await on(desktop, (engine) => engine.sync());
		expect(secondOne!.pushed).toBe(0);
	});
});

describe("Sparsamkeit", () => {
	it("ein Durchgang ohne Aenderungen kostet genau eine Anfrage", async () => {
		// Der Anspruch aus dem Entwurf: im Leerlauf passiert nichts. Waere hier ein
		// Poller am Werk, stuenden hier Dutzende Anfragen.
		const phone = new Device("handy");
		await on(phone, (engine) => engine.sync());
		server.calls = [];
		await on(phone, (engine) => engine.sync());
		expect(server.calls).toEqual(["GET /api/sync"]);
	});

	it("laesst zwei gleichzeitige Anstoesse nicht nebeneinanderlaufen", async () => {
		// Sonst zoegen sie sich gegenseitig die Outbox unter den Fuessen weg.
		const phone = new Device("handy");
		const [a, b] = await on(phone, async (engine) => {
			await store.saveEntries(MONTH, [entry("e1")]);
			return Promise.all([engine.sync(), engine.sync()]);
		});
		expect([a, b].filter((x) => x === null)).toHaveLength(1);
		expect(server.rows.size).toBe(1);
	});

	it("blaettert durch einen grossen Bestand, ohne etwas zu ueberspringen", async () => {
		const phone = new Device("handy");
		await on(phone, async (engine) => {
			const many = Array.from({ length: 450 }, (_, i) =>
				entry(`e${i}`, { startTs: ts(15, 9) + i * 1000, endTs: ts(15, 9) + i * 1000 + 60_000 })
			);
			await store.saveEntries(MONTH, many);
			return engine.sync();
		});

		const desktop = new Device("rechner");
		await on(desktop, (engine) => engine.sync());
		const list = await entries(desktop);
		expect(list).toHaveLength(450);
		expect(new Set(list.map((e) => e.id)).size).toBe(450);
	});
});

describe("Robustheit", () => {
	it("ein unlesbarer Datensatz haelt den Abgleich nicht an", async () => {
		// Ein einzelner unlesbarer Datensatz ist ein Aergernis, ein
		// steckengebliebener Abgleich ein Ausfall.
		const phone = new Device("handy");
		await on(phone, async (engine) => {
			await store.saveEntries(MONTH, [entry("e1")]);
			return engine.sync();
		});

		// Ein Datensatz mit Chiffrat aus einem FREMDEN Tresor.
		const otherKey = key;
		key = await createVaultKey();
		const foreign = new Device("fremd");
		await on(foreign, async (engine) => {
			await store.saveEntries("2026-08", [entry("e2", { startTs: ts(20, 9) })]);
			return engine.sync();
		});
		key = otherKey;

		// Ein Geraet mit dem RICHTIGEN Schluessel bekommt e1 und ueberspringt e2.
		const desktop = new Device("rechner");
		await expect(on(desktop, (engine) => engine.sync())).resolves.toBeTruthy();
		expect((await entries(desktop)).map((e) => e.id)).toEqual(["e1"]);
		expect(await entries(desktop, "2026-08")).toEqual([]);
	});

	it("merkt sich den Stand, damit der naechste Durchgang nur das Delta holt", async () => {
		const phone = new Device("handy");
		await on(phone, async (engine) => {
			await store.saveEntries(MONTH, [entry("e1")]);
			return engine.sync();
		});
		const desktop = new Device("rechner");
		await on(desktop, (engine) => engine.sync());
		expect(desktop.state.seq).toBe(server.seq);
	});
});

describe("Der Server kennt den Bestand nicht mehr", () => {
	// Die Lage nach einem aufgeloesten Konto oder einem aus aelterer Sicherung
	// wieder aufgesetzten Server: lokal stehen Fassungsnummern, die beim Server
	// niemand kennt. Er antwortet auf jede mit einem Konflikt gegen Fassung 0.

	it("schreibt die Daten neu an, statt fuer immer im Konflikt zu haengen", async () => {
		const pc = new Device("pc");
		await on(pc, async (engine) => {
			await store.saveEntries(MONTH, [entry("e1"), entry("e2")]);
			await engine.sync();
		});
		expect(server.rows.size).toBe(2);

		// Das Konto wird aufgeloest. Der Server hat nichts mehr - das Geraet weiss
		// es noch nicht.
		server.rows.clear();
		server.seq = 0;

		const result = await on(pc, async (engine) => {
			const list = await store.loadEntries(MONTH);
			list[0] = { ...list[0], note: "nach dem Neuaufsetzen" };
			await store.saveEntries(MONTH, list);
			return engine.sync();
		});

		expect(result?.pushed).toBe(1);
		expect(server.rows.has("e1")).toBe(true);
		expect(server.rows.get("e1")?.rev).toBe(1);
	});

	it("haelt danach nichts mehr offen", async () => {
		const pc = new Device("pc");
		await on(pc, async (engine) => {
			await store.saveEntries(MONTH, [entry("e1")]);
			await engine.sync();
		});
		server.rows.clear();
		server.seq = 0;

		const open = await on(pc, async (engine) => {
			const list = await store.loadEntries(MONTH);
			await store.saveEntries(MONTH, [{ ...list[0], note: "geaendert" }]);
			await engine.sync();
			return pendingChanges();
		});
		expect(open).toHaveLength(0);
	});

	it("das neu angeschriebene Chiffrat laesst sich woanders oeffnen", async () => {
		// Der Punkt, an dem es leicht schiefgeht: die Bindung des Chiffrats zeigt
		// auf die Fassung, die daraus wird. Wird die Fassung auf 0 zurueckgesetzt,
		// MUSS das vor dem Versiegeln passieren - sonst ist die Bindung falsch,
		// und das Chiffrat laesst sich nirgends mehr oeffnen. Ein zweites Geraet
		// ist der einzige ehrliche Beleg dafuer.
		const pc = new Device("pc");
		await on(pc, async (engine) => {
			await store.saveEntries(MONTH, [entry("e1", { note: "erste Fassung" })]);
			await engine.sync();
		});
		server.rows.clear();
		server.seq = 0;

		await on(pc, async (engine) => {
			const list = await store.loadEntries(MONTH);
			await store.saveEntries(MONTH, [{ ...list[0], note: "nach dem Neuanfang" }]);
			await engine.sync();
		});

		const phone = new Device("handy");
		await on(phone, (engine) => engine.sync());
		const read = await entries(phone);
		expect(read).toHaveLength(1);
		expect(read[0].note).toBe("nach dem Neuanfang");
	});

	it("verwechselt einen echten Konflikt nicht damit", async () => {
		// Die Merkliste darf nicht dazu fuehren, dass spaeter mit Fassung 0
		// geschrieben wird, wo der Server sehr wohl etwas hat - das wuerde die
		// Arbeit des anderen Geraets ueberschreiben, ohne sie gesehen zu haben.
		const pc = new Device("pc");
		const phone = new Device("handy");

		await on(pc, async (engine) => {
			await store.saveEntries(MONTH, [entry("e1", { note: "vom PC" })]);
			await engine.sync();
		});
		await on(phone, (engine) => engine.sync());

		// Beide aendern, ohne voneinander zu wissen.
		await on(phone, async (engine) => {
			const list = await store.loadEntries(MONTH);
			await store.saveEntries(MONTH, [{ ...list[0], note: "vom Handy", updatedAt: ts(15, 14) }]);
			await engine.sync();
		});
		await on(pc, async (engine) => {
			const list = await store.loadEntries(MONTH);
			await store.saveEntries(MONTH, [{ ...list[0], note: "spaeter vom PC", updatedAt: ts(15, 15) }]);
			await engine.sync();
		});

		// Die Fassung ist ordentlich weitergezaehlt - nichts wurde ueberschrieben,
		// ohne den Zwischenstand gesehen zu haben.
		expect(server.rows.get("e1")?.rev).toBe(3);
	});
});

describe("onProgress – Ladeanzeige beim Massenimport", () => {
	/**
	 * Geraet mit eigenem SyncEngine und onProgress-Callback.
	 * Gibt alle Progress-Events zurueck.
	 */
	async function syncWithProgress(g: Device): Promise<{ events: import("./engine").SyncProgress[] }> {
		resetFakeFs();
		for (const [k, v] of g.files) files.set(k, v);
		resetOutboxForTests();
		await startTracking(g.id);

		const events: import("./engine").SyncProgress[] = [];
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
			saveState: async (s) => { g.state = s; },
			onProgress: (p) => events.push({ ...p })
		});
		engine.setMonthLister(() => store.listEntryMonths());

		try {
			await engine.sync();
		} finally {
			g.files = new Map(files);
		}
		return { events };
	}

	it("ruft onProgress mit phase=pulling auf, waehrend Eintraege gezogen werden", async () => {
		// Geraet 1 laedt 25 Eintraege hoch.
		const sender = new Device("sender");
		const entries25 = Array.from({ length: 25 }, (_, i) =>
			entry(`e${i}`, { startTs: ts(1 + (i % 15), 9 + (i % 8)) })
		);
		await on(sender, async (engine) => {
			await store.saveEntries(MONTH, entries25);
			return engine.sync();
		});

		// Geraet 2 zieht die 25 Eintraege herunter - onProgress soll firing.
		const recipient = new Device("empfaenger");
		const { events } = await syncWithProgress(recipient);

		// Es muss mindestens ein Event mit phase=pulling und pulled>=20 geben.
		const bulkEvents = events.filter((e) => e.phase === "pulling" && e.pulled >= 20);
		expect(bulkEvents.length).toBeGreaterThan(0);

		// Der finale pulled-Zaehler muss 25 betragen.
		const lastPull = [...events].reverse().find((e) => e.phase === "pulling");
		expect(lastPull?.pulled).toBe(25);
	});

	it("ruft onProgress NICHT mit pulled>=20 auf, wenn weniger als 20 Eintraege kommen", async () => {
		// Nur 5 Eintraege hochladen.
		const sender = new Device("sender2");
		const entries5 = Array.from({ length: 5 }, (_, i) => entry(`f${i}`));
		await on(sender, async (engine) => {
			await store.saveEntries(MONTH, entries5);
			return engine.sync();
		});

		const recipient = new Device("empfaenger2");
		const { events } = await syncWithProgress(recipient);

		// Kein Event mit pulled >= 20.
		const bulkEvents = events.filter((e) => e.phase === "pulling" && e.pulled >= 20);
		expect(bulkEvents).toHaveLength(0);
	});

	it("endet immer mit phase=idle", async () => {
		const sender = new Device("sender3");
		await on(sender, async (engine) => {
			await store.saveEntries(MONTH, [entry("g1")]);
			return engine.sync();
		});

		const recipient = new Device("empfaenger3");
		const { events } = await syncWithProgress(recipient);

		// Letztes Event muss idle sein.
		expect(events.at(-1)?.phase).toBe("idle");
	});

	it("meldet Fortschritt bei über 200 Einträgen (voller Batch)", async () => {
		const sender = new Device("sender-bulk");
		const entries250 = Array.from({ length: 250 }, (_, i) =>
			entry(`bulk-${i}`, { startTs: ts(1 + (i % 20), 8 + (i % 8)) })
		);
		await on(sender, async (engine) => {
			await store.saveEntries(MONTH, entries250);
			return engine.sync();
		});

		const recipient = new Device("empfaenger-bulk");
		const { events } = await syncWithProgress(recipient);

		// Mindestens zwei pulling-Schritte (bei BATCH=200):
		const pullingEvents = events.filter((e) => e.phase === "pulling");
		expect(pullingEvents.length).toBeGreaterThanOrEqual(2);

		const maxPulled = Math.max(...pullingEvents.map((e) => e.pulled));
		expect(maxPulled).toBe(250);
	});
});
