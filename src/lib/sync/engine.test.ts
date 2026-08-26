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

/**
 * Warten, bis die Uhr weiterspringt.
 *
 * Wer entscheidet, welche von zwei Aenderungen gilt, vergleicht `updatedAt` -
 * und bei Gleichstand die Geraetekennung. Fallen zwei Handlungen im Test in
 * dieselbe Millisekunde, entscheidet also das Alphabet statt der Reihenfolge,
 * und derselbe Test faellt mal so und mal so aus. Wo unten "danach" gemeint ist,
 * steht deshalb das hier - es kostet eine Millisekunde und kann nicht
 * durchrutschen.
 */
async function danach(): Promise<void> {
	const jetzt = Date.now();
	while (Date.now() === jetzt) await new Promise((r) => setTimeout(r, 1));
}

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
		await danach();
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

		// Der Rechner aendert - auf dem Stand, den er kennt, und nachweislich spaeter.
		await danach();
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

/** Ein Zeitstempel im Folgemonat - fuer alles, was ueber die Monatsgrenze geht. */
const tsAug = (tag: number, stunde: number) => Date.UTC(2026, 7, tag, stunde) + 2 * 3600_000;

/**
 * Eine Loeschung beim Server nachstellen, ohne ein Geraet dafuer zu bemuehen.
 *
 * Ein Grabstein ist eine Zeile ohne Chiffrat; mehr braucht es nicht. So laesst
 * sich eine Loeschung MITTEN in den Betrieb eines Geraets legen statt nur
 * zwischen zwei seiner Sitzungen - und genau darauf kommt es unten an.
 *
 * Der Zeitstempel liegt bewusst in der Zukunft: die Loeschung soll den Wettstreit
 * eindeutig gewinnen und nicht daran haengen, ob zwei Aufrufe von Date.now() in
 * dieselbe Millisekunde fielen.
 */
function grabstein(id: string, rev: number): void {
	server.seq++;
	const alt = server.rows.get(id);
	const wann = Date.now() + 60_000;
	server.rows.set(id, {
		id,
		kind: "entry",
		bucket: alt?.bucket ?? null,
		seq: server.seq,
		rev,
		updatedAt: wann,
		deviceId: "handy",
		deletedAt: wann,
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
		const handy = new Geraet("handy");
		await auf(handy, async (engine) => {
			await store.saveEntries(MONAT, [eintrag("e1")]);
			return engine.sync();
		});
		const rechner = new Geraet("rechner");
		await auf(rechner, (engine) => engine.sync());
		expect(await eintraege(rechner, MONAT)).toHaveLength(1);

		await auf(handy, async (engine) => {
			const seiner = (await store.loadEntries(MONAT))[0];
			await store.saveEntries(MONAT, []);
			await store.saveEntries("2026-08", [
				{ ...seiner, startTs: tsAug(3, 9), endTs: tsAug(3, 12) }
			]);
			return engine.sync();
		});

		await auf(rechner, (engine) => engine.sync());
		expect((await eintraege(rechner, "2026-08")).map((e) => e.id)).toEqual(["e1"]);
		// Und NICHT zusaetzlich im alten Monat: sonst zaehlte dieselbe Stunde zweimal.
		expect(await eintraege(rechner, MONAT)).toEqual([]);
	});

	it("laesst hoechstens einen Timer laufen, auch ueber zwei Monate", async () => {
		// Am Monatsende am Handy gestartet, im naechsten Monat am Rechner noch
		// einmal. Zwei laufende Timer in zwei Dateien - monatsweise betrachtet stand
		// in jeder genau einer, und beide zaehlten weiter.
		const handy = new Geraet("handy");
		await auf(handy, async (engine) => {
			await store.saveEntries(MONAT, [eintrag("h1", { startTs: ts(30, 10), endTs: null })]);
			return engine.sync();
		});

		const rechner = new Geraet("rechner");
		await auf(rechner, async (engine) => {
			await store.saveEntries("2026-08", [eintrag("r1", { startTs: tsAug(2, 10), endTs: null })]);
			return engine.sync();
		});

		const juli = await eintraege(rechner, MONAT);
		const august = await eintraege(rechner, "2026-08");
		const offen = [...juli, ...august].filter((e) => e.endTs === null);
		expect(offen.map((e) => e.id)).toEqual(["r1"]);
		// Der Lauf vom Handy ist nicht weg, sondern beendet - dort steckt echte Zeit.
		expect(juli.find((e) => e.id === "h1")!.endTs).toBe(tsAug(2, 10));
	});

	it("findet den Monat eines Grabsteins, den es beim Start noch nicht gab", async () => {
		// Ein Programm, das laeuft und laeuft. Die Monatsliste darf ihm nicht
		// einfrieren: sonst faende die Loeschung ihren Monat nicht, wuerde still
		// verworfen - und `seq` liefe trotzdem weiter. Endgueltig verloren.
		const handy = new Geraet("handy");
		await auf(handy, async (engine) => {
			await store.saveEntries(MONAT, [eintrag("e1")]);
			return engine.sync();
		});
		// Ein Grabstein fuer etwas, das der Rechner nie hatte. Er ist der Grund,
		// weshalb die Monatsliste im ersten Durchgang ueberhaupt gezogen wird - zu
		// einem Zeitpunkt, an dem es noch keine Monatsdatei gibt.
		grabstein("nie-gesehen", 1);

		const rechner = new Geraet("rechner");
		await auf(rechner, async (engine) => {
			await engine.sync();
			expect(await store.loadEntries(MONAT)).toHaveLength(1);

			grabstein("e1", 2);
			await engine.sync();
			expect(await store.loadEntries(MONAT)).toEqual([]);
		});
	});

	it("ein geloeschtes Jahr kommt beim naechsten Durchgang nicht zurueck", async () => {
		const handy = new Geraet("handy");
		await auf(handy, async (engine) => {
			await store.saveEntries("2025-03", [
				eintrag("alt", { startTs: Date.UTC(2025, 2, 4, 9), endTs: Date.UTC(2025, 2, 4, 12) })
			]);
			return engine.sync();
		});
		const rechner = new Geraet("rechner");
		await auf(rechner, (engine) => engine.sync());
		expect(await eintraege(rechner, "2025-03")).toHaveLength(1);

		await auf(handy, async (engine) => {
			expect(await store.deleteYear(2025)).toEqual(["2025-03"]);
			// Das Loeschen muss durch den Haken gegangen sein, sonst weiss der
			// Abgleich nichts davon.
			expect(pendingChanges()).toEqual([
				expect.objectContaining({ kind: "entry", id: "alt", deleted: true })
			]);
			return engine.sync();
		});

		// Der naechste Durchgang holt es nicht wieder herunter ...
		await auf(handy, (engine) => engine.sync());
		expect(await eintraege(handy, "2025-03")).toEqual([]);
		// ... und das andere Geraet raeumt mit auf.
		await auf(rechner, (engine) => engine.sync());
		expect(await eintraege(rechner, "2025-03")).toEqual([]);
	});
});

describe("Was der Mensch erfahren muss", () => {
	it("zaehlt eine unterlegene eigene Aenderung auch beim Konflikt-Aufloesen", async () => {
		// Der haeufigste Weg in einen verlorenen Eigenstand fuehrt genau hier
		// entlang: die eigene Aenderung stoesst auf einen Konflikt, und beim
		// Aufloesen gewinnt der Server. Bliebe die Zahl dort liegen, stuende am Ende
		// "abgeglichen" da - ohne ein Wort darueber, dass etwas ueberschrieben wurde.
		const handy = new Geraet("handy");
		await auf(handy, async (engine) => {
			await store.saveEntries(MONAT, [eintrag("e1", { note: "handy" })]);
			return engine.sync();
		});
		const rechner = new Geraet("rechner");
		await auf(rechner, (engine) => engine.sync());

		// Das Handy aendert und laedt hoch - und zwar nachweislich spaeter, damit
		// der Wettstreit nicht an einer Millisekunde haengt.
		await auf(handy, async (engine) => {
			const seiner = (await store.loadEntries(MONAT))[0];
			await store.saveEntries(MONAT, [{ ...seiner, note: "handy zwei" }]);
			return engine.sync();
		});
		const zeile = server.rows.get("e1")!;
		server.rows.set("e1", { ...zeile, updatedAt: Date.now() + 60_000 });

		// Der Rechner aendert auf seinem alten Stand und laeuft in den Konflikt.
		const ergebnis = await auf(rechner, async (engine) => {
			const seiner = (await store.loadEntries(MONAT))[0];
			await store.saveEntries(MONAT, [{ ...seiner, note: "rechner" }]);
			return engine.sync();
		});

		expect(ergebnis!.lostEdits).toBe(1);
		expect((await eintraege(rechner))[0].note).toBe("handy zwei");
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

describe("Der Server kennt den Bestand nicht mehr", () => {
	// Die Lage nach einem aufgeloesten Konto oder einem aus aelterer Sicherung
	// wieder aufgesetzten Server: lokal stehen Fassungsnummern, die beim Server
	// niemand kennt. Er antwortet auf jede mit einem Konflikt gegen Fassung 0.
	//
	// Ohne Gegenmassnahme ist das eine stille Sackgasse - und zwar die
	// unangenehmste Sorte: lokal ist alles heil, es kommt nur nie an.

	it("schreibt die Daten neu an, statt fuer immer im Konflikt zu haengen", async () => {
		const pc = new Geraet("pc");
		await auf(pc, async (engine) => {
			await store.saveEntries(MONAT, [eintrag("e1"), eintrag("e2")]);
			await engine.sync();
		});
		expect(server.rows.size).toBe(2);

		// Das Konto wird aufgeloest. Der Server hat nichts mehr - das Geraet weiss
		// es noch nicht.
		server.rows.clear();
		server.seq = 0;

		const ergebnis = await auf(pc, async (engine) => {
			const liste = await store.loadEntries(MONAT);
			liste[0] = { ...liste[0], note: "nach dem Neuaufsetzen" };
			await store.saveEntries(MONAT, liste);
			return engine.sync();
		});

		expect(ergebnis?.pushed).toBe(1);
		expect(server.rows.has("e1")).toBe(true);
		expect(server.rows.get("e1")?.rev).toBe(1);
	});

	it("haelt danach nichts mehr offen", async () => {
		const pc = new Geraet("pc");
		await auf(pc, async (engine) => {
			await store.saveEntries(MONAT, [eintrag("e1")]);
			await engine.sync();
		});
		server.rows.clear();
		server.seq = 0;

		const offen = await auf(pc, async (engine) => {
			const liste = await store.loadEntries(MONAT);
			await store.saveEntries(MONAT, [{ ...liste[0], note: "geaendert" }]);
			await engine.sync();
			return pendingChanges();
		});
		expect(offen).toHaveLength(0);
	});

	it("das neu angeschriebene Chiffrat laesst sich woanders oeffnen", async () => {
		// Der Punkt, an dem es leicht schiefgeht: die Bindung des Chiffrats zeigt
		// auf die Fassung, die daraus wird. Wird die Fassung auf 0 zurueckgesetzt,
		// MUSS das vor dem Versiegeln passieren - sonst ist die Bindung falsch,
		// und das Chiffrat laesst sich nirgends mehr oeffnen. Ein zweites Geraet
		// ist der einzige ehrliche Beleg dafuer.
		const pc = new Geraet("pc");
		await auf(pc, async (engine) => {
			await store.saveEntries(MONAT, [eintrag("e1", { note: "erste Fassung" })]);
			await engine.sync();
		});
		server.rows.clear();
		server.seq = 0;

		await auf(pc, async (engine) => {
			const liste = await store.loadEntries(MONAT);
			await store.saveEntries(MONAT, [{ ...liste[0], note: "nach dem Neuanfang" }]);
			await engine.sync();
		});

		const handy = new Geraet("handy");
		await auf(handy, (engine) => engine.sync());
		const gelesen = await eintraege(handy);
		expect(gelesen).toHaveLength(1);
		expect(gelesen[0].note).toBe("nach dem Neuanfang");
	});

	it("verwechselt einen echten Konflikt nicht damit", async () => {
		// Die Merkliste darf nicht dazu fuehren, dass spaeter mit Fassung 0
		// geschrieben wird, wo der Server sehr wohl etwas hat - das wuerde die
		// Arbeit des anderen Geraets ueberschreiben, ohne sie gesehen zu haben.
		const pc = new Geraet("pc");
		const handy = new Geraet("handy");

		await auf(pc, async (engine) => {
			await store.saveEntries(MONAT, [eintrag("e1", { note: "vom PC" })]);
			await engine.sync();
		});
		await auf(handy, (engine) => engine.sync());

		// Beide aendern, ohne voneinander zu wissen.
		await auf(handy, async (engine) => {
			const liste = await store.loadEntries(MONAT);
			await store.saveEntries(MONAT, [{ ...liste[0], note: "vom Handy", updatedAt: ts(15, 14) }]);
			await engine.sync();
		});
		await auf(pc, async (engine) => {
			const liste = await store.loadEntries(MONAT);
			await store.saveEntries(MONAT, [{ ...liste[0], note: "spaeter vom PC", updatedAt: ts(15, 15) }]);
			await engine.sync();
		});

		// Die Fassung ist ordentlich weitergezaehlt - nichts wurde ueberschrieben,
		// ohne den Zwischenstand gesehen zu haben.
		expect(server.rows.get("e1")?.rev).toBe(3);
	});
});
