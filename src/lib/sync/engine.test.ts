// Zwei Geraete an einem Konto - der ganze Weg.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeSyncServer } from "../testing/fakeSyncServer";
import { FakeDevice, onDevice, withoutAccount } from "../testing/syncDevice";
import type { VaultKey } from "../crypto/vault";

vi.mock("@tauri-apps/plugin-fs", async () => (await import("../testing/fakeFs")).fakeFs);

const { createVaultKey, bucketFor } = await import("../crypto/vault");
const { monthKey, prevMonthKey } = await import("../time");
const { resetOutboxForTests, pendingChanges } = await import("./outbox");
const { resetFakeFs } = await import("../testing/fakeFs");
const store = await import("../store");
const { defaultSettings } = await import("../types");
import type { Entry } from "../types";
import type { SyncEngine, SyncProgress, SyncState } from "./engine";

let server: FakeSyncServer;
let key: VaultKey;

const on = <T,>(g: FakeDevice, fn: (engine: SyncEngine) => Promise<T>): Promise<T> =>
	onDevice({ server, key }, g, fn);

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

/** Was auf einem Device in einem Monat liegt. */
async function entries(g: FakeDevice, month = MONTH): Promise<Entry[]> {
	return on(g, () => store.loadEntries(month));
}

beforeEach(async () => {
	resetFakeFs();
	resetOutboxForTests();
	server = new FakeSyncServer();
	key = await createVaultKey();
});

describe("Ein Device allein", () => {
	it("laedt eine Aenderung hoch und haelt danach nichts mehr offen", async () => {
		const phone = new FakeDevice("handy");
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
		const phone = new FakeDevice("handy");
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
		const phone = new FakeDevice("handy");
		await on(phone, async (engine) => {
			await store.saveEntries(MONTH, [entry("e1")]);
			return engine.sync();
		});
		expect((await entries(phone))[0].rev).toBe(1);
	});

	it("laedt beim zweiten Durchgang nichts erneut hoch", async () => {
		const phone = new FakeDevice("handy");
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
	async function phoneWith(e: Entry): Promise<FakeDevice> {
		const phone = new FakeDevice("handy");
		await on(phone, async (engine) => {
			await store.saveEntries(MONTH, [e]);
			return engine.sync();
		});
		return phone;
	}

	it("das zweite Device bekommt den Eintrag des ersten - entschluesselt", async () => {
		await phoneWith(entry("e1", { note: "vom Handy" }));

		const desktop = new FakeDevice("rechner");
		await on(desktop, (engine) => engine.sync());

		const list = await entries(desktop);
		expect(list).toHaveLength(1);
		expect(list[0].note).toBe("vom Handy");
		expect(list[0].activityId).toBe("akt-1");
	});

	it("uebernimmt eine Loeschung", async () => {
		const phone = await phoneWith(entry("e1"));
		const desktop = new FakeDevice("rechner");
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
		const desktop = new FakeDevice("rechner");
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

	it("loest einen Konflikt aus der Antwort, ohne die Historie zu ziehen", async () => {
		// Der Server schickt den Stand, an dem es gescheitert ist, ohnehin mit.
		// Ihn zu nehmen kostet nichts; die Historie dafuer durchzublaettern kann
		// auf einem Konto mit Jahren an Daten eine ganze Weile dauern.
		const phone = await phoneWith(entry("e1", { note: "handy" }));
		const desktop = new FakeDevice("rechner");
		await on(desktop, (engine) => engine.sync());

		// Das Handy aendert denselben Eintrag - damit steht der Rechner auf einer
		// Fassung, die der Server nicht mehr hat.
		await afterwards();
		await on(phone, async (engine) => {
			const mine = (await store.loadEntries(MONTH))[0];
			await store.saveEntries(MONTH, [{ ...mine, note: "handy zwei" }]);
			return engine.sync();
		});

		// Historie beim Server, die mit dem Konflikt nichts zu tun hat.
		await on(phone, async (engine) => {
			const old = Array.from({ length: 40 }, (_, i) =>
				entry(`alt${i}`, {
					startTs: Date.UTC(2026, 5, 1 + (i % 28), 9) + 2 * 3600_000,
					endTs: Date.UTC(2026, 5, 1 + (i % 28), 10) + 2 * 3600_000
				})
			);
			await store.saveEntries("2026-06", old);
			return engine.sync();
		});

		// Der Rechner aendert auf seinem alten Stand und laeuft damit in den Konflikt.
		await afterwards();
		server.calls.length = 0;
		const result = await on(desktop, async (engine) => {
			const theirs = (await store.loadEntries(MONTH))[0];
			await store.saveEntries(MONTH, [{ ...theirs, note: "rechner" }]);
			return engine.sync();
		});

		// Die Aenderung ist durch - darum geht es zuerst.
		expect(result!.pushed).toBe(1);
		expect([...server.rows.values()].find((r) => r.id === "e1")!.rev).toBe(3);

		// Und zwar OHNE Abruf dazwischen: der zweite Versuch folgt direkt auf den
		// ersten. Ein Abruf an dieser Stelle zoege die ganze Historie und risse
		// damit das Budget ein, das der gestaffelte Abgleich setzt.
		const first = server.calls.indexOf("POST /api/sync");
		const second = server.calls.indexOf("POST /api/sync", first + 1);
		expect(second).toBeGreaterThan(first);
		expect(server.calls.slice(first, second)).not.toContain("GET /api/sync");
	});

	it("laesst hoechstens einen Timer laufen, wenn beide Geraete einen halten", async () => {
		// Der Fall, um den es dem Nutzer geht: am Handy gestartet, der Rechner
		// wacht auf und weiss nichts davon.
		await phoneWith(entry("h1", { endTs: null, startTs: ts(15, 9) }));

		const desktop = new FakeDevice("rechner");
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
		const phone = new FakeDevice("handy");
		await on(phone, async (engine) => {
			await store.saveActivities([
				{ id: "a1", name: "Projekt Alpha", sortOrder: 0, archived: false, isAbsence: false }
			]);
			return engine.sync();
		});

		const desktop = new FakeDevice("rechner");
		await on(desktop, (engine) => engine.sync());
		const fetched = await on(desktop, () => store.loadActivities());
		expect(fetched.map((a) => a.name)).toEqual(["Projekt Alpha"]);
	});

	it("gleicht Einstellungen ab, ohne die geliehene Id zu hinterlassen", async () => {
		const phone = new FakeDevice("handy");
		await on(phone, async (engine) => {
			await store.saveSettings({ ...defaultSettings, hoursPerDay: 8, timeZone: "Europe/Berlin" });
			return engine.sync();
		});

		const desktop = new FakeDevice("rechner");
		await on(desktop, (engine) => engine.sync());
		const s = await on(desktop, () => store.loadSettings());
		expect(s.hoursPerDay).toBe(8);
		expect((s as unknown as { id?: string }).id).toBeUndefined();
	});

	it("gleicht Pomodoro-Einstellungen und laufenden Timer korrekt ab", async () => {
		const phone = new FakeDevice("handy");
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

		const desktop = new FakeDevice("rechner");
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

/** Eine Loeschung beim Server nachstellen, ohne ein Device dafuer zu bemuehen. */
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
		// gewinnt), der Server sieht also nie eine Loeschung - das andere Device
		// muss den Umzug am neuen Startzeitpunkt selbst erkennen.
		const phone = new FakeDevice("handy");
		await on(phone, async (engine) => {
			await store.saveEntries(MONTH, [entry("e1")]);
			return engine.sync();
		});
		const desktop = new FakeDevice("rechner");
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
		const phone = new FakeDevice("handy");
		await on(phone, async (engine) => {
			await store.saveEntries(MONTH, [entry("h1", { startTs: ts(30, 10), endTs: null })]);
			return engine.sync();
		});

		const desktop = new FakeDevice("rechner");
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

	it("findet den Monat eines Loeschmarkers, den es beim Start noch nicht gab", async () => {
		// Ein Programm, das laeuft und laeuft. Die Monatsliste darf ihm nicht
		// einfrieren: sonst faende die Loeschung ihren Monat nicht, wuerde still
		// verworfen - und `seq` liefe trotzdem weiter. Endgueltig verloren.
		const phone = new FakeDevice("handy");
		await on(phone, async (engine) => {
			await store.saveEntries(MONTH, [entry("e1")]);
			return engine.sync();
		});
		// Ein Loeschmarker fuer etwas, das der Rechner nie hatte. Er ist der Grund,
		// weshalb die Monatsliste im ersten Durchgang ueberhaupt gezogen wird - zu
		// einem Zeitpunkt, an dem es noch keine Monatsdatei gibt.
		tombstone("nie-gesehen", 1);

		const desktop = new FakeDevice("rechner");
		await on(desktop, async (engine) => {
			await engine.sync();
			expect(await store.loadEntries(MONTH)).toHaveLength(1);

			tombstone("e1", 2);
			await engine.sync();
			expect(await store.loadEntries(MONTH)).toEqual([]);
		});
	});

	it("ein geloeschtes Jahr kommt beim naechsten Durchgang nicht zurueck", async () => {
		const phone = new FakeDevice("handy");
		await on(phone, async (engine) => {
			await store.saveEntries("2025-03", [
				entry("alt", { startTs: Date.UTC(2025, 2, 4, 9), endTs: Date.UTC(2025, 2, 4, 12) })
			]);
			return engine.sync();
		});
		const desktop = new FakeDevice("rechner");
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
		// ... und das andere Device raeumt mit auf.
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
		const phone = new FakeDevice("handy");
		await on(phone, async (engine) => {
			await store.saveEntries(MONTH, [entry("e1", { note: "handy" })]);
			return engine.sync();
		});
		const desktop = new FakeDevice("rechner");
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
		// Device, das dieselben Datensaetze im Kreis schickt.
		const phone = new FakeDevice("handy");
		await on(phone, async (engine) => {
			await store.saveEntries(MONTH, [entry("e1")]);
			await store.saveActivities([
				{ id: "a1", name: "Alpha", sortOrder: 0, archived: false, isAbsence: false }
			]);
			return engine.sync();
		});

		const desktop = new FakeDevice("rechner");
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
		const phone = new FakeDevice("handy");
		await on(phone, (engine) => engine.sync());
		server.calls = [];
		await on(phone, (engine) => engine.sync());
		expect(server.calls).toEqual(["GET /api/sync"]);
	});

	it("laesst zwei gleichzeitige Anstoesse nicht nebeneinanderlaufen", async () => {
		// Sonst zoegen sie sich gegenseitig die Outbox unter den Fuessen weg.
		const phone = new FakeDevice("handy");
		const [a, b] = await on(phone, async (engine) => {
			await store.saveEntries(MONTH, [entry("e1")]);
			return Promise.all([engine.sync(), engine.sync()]);
		});
		// Der zweite Anstoss haengt sich an den laufenden Durchgang, statt ins Leere
		// zu greifen: wer `sync()` abwartet, will wissen, dass abgeglichen wurde.
		expect(a).not.toBeNull();
		expect(b).toBe(a);
		expect(server.rows.size).toBe(1);
	});

	it("blaettert durch einen grossen Bestand, ohne etwas zu ueberspringen", async () => {
		const phone = new FakeDevice("handy");
		await on(phone, async (engine) => {
			const many = Array.from({ length: 450 }, (_, i) =>
				entry(`e${i}`, { startTs: ts(15, 9) + i * 1000, endTs: ts(15, 9) + i * 1000 + 60_000 })
			);
			await store.saveEntries(MONTH, many);
			return engine.sync();
		});

		const desktop = new FakeDevice("rechner");
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
		const phone = new FakeDevice("handy");
		await on(phone, async (engine) => {
			await store.saveEntries(MONTH, [entry("e1")]);
			return engine.sync();
		});

		// Ein Datensatz mit Chiffrat aus einem FREMDEN Tresor.
		const otherKey = key;
		key = await createVaultKey();
		const foreign = new FakeDevice("fremd");
		await on(foreign, async (engine) => {
			await store.saveEntries("2026-08", [entry("e2", { startTs: ts(20, 9) })]);
			return engine.sync();
		});
		key = otherKey;

		// Ein Device mit dem RICHTIGEN Schluessel bekommt e1 und ueberspringt e2.
		const desktop = new FakeDevice("rechner");
		await expect(on(desktop, (engine) => engine.sync())).resolves.toBeTruthy();
		expect((await entries(desktop)).map((e) => e.id)).toEqual(["e1"]);
		expect(await entries(desktop, "2026-08")).toEqual([]);
	});

	it("merkt sich den Stand, damit der naechste Durchgang nur das Delta holt", async () => {
		const phone = new FakeDevice("handy");
		await on(phone, async (engine) => {
			await store.saveEntries(MONTH, [entry("e1")]);
			return engine.sync();
		});
		const desktop = new FakeDevice("rechner");
		await on(desktop, (engine) => engine.sync());
		expect(desktop.state.seq).toBe(server.seq);
	});
});

describe("Der Server kennt den Bestand nicht mehr", () => {
	// Die Lage nach einem aufgeloesten Konto oder einem aus aelterer Sicherung
	// wieder aufgesetzten Server: lokal stehen Fassungsnummern, die beim Server
	// niemand kennt. Er antwortet auf jede mit einem Konflikt gegen Fassung 0.

	it("schreibt die Daten neu an, statt fuer immer im Konflikt zu haengen", async () => {
		const pc = new FakeDevice("pc");
		await on(pc, async (engine) => {
			await store.saveEntries(MONTH, [entry("e1"), entry("e2")]);
			await engine.sync();
		});
		expect(server.rows.size).toBe(2);

		// Das Konto wird aufgeloest. Der Server hat nichts mehr - das Device weiss
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
		const pc = new FakeDevice("pc");
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
		// und das Chiffrat laesst sich nirgends mehr oeffnen. Ein zweites Device
		// ist der einzige ehrliche Beleg dafuer.
		const pc = new FakeDevice("pc");
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

		const phone = new FakeDevice("handy");
		await on(phone, (engine) => engine.sync());
		const read = await entries(phone);
		expect(read).toHaveLength(1);
		expect(read[0].note).toBe("nach dem Neuanfang");
	});

	it("verwechselt einen echten Konflikt nicht damit", async () => {
		// Die Merkliste darf nicht dazu fuehren, dass spaeter mit Fassung 0
		// geschrieben wird, wo der Server sehr wohl etwas hat - das wuerde die
		// Arbeit des anderen Geraets ueberschreiben, ohne sie gesehen zu haben.
		const pc = new FakeDevice("pc");
		const phone = new FakeDevice("handy");

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

describe("Eingelesene Reports", () => {
	const day = (date: string, hours: number) => ({
		date,
		firstIn: "07:30",
		lastOut: "16:45",
		hours,
		flags: []
	});

	/** Ein Report, wie ihn der Import ablegt. */
	const report = (month = MONTH, hours = 7.5) => ({
		month,
		importedAt: Date.UTC(2026, 6, 20),
		days: [day(`${month}-15`, hours)]
	});

	it("traegt einen Report zum anderen Device", async () => {
		const desktop = new FakeDevice("rechner");
		await on(desktop, async (engine) => {
			await store.saveTimeReport(report());
			return engine.sync();
		});

		const laptop = new FakeDevice("laptop");
		await on(laptop, (engine) => engine.sync());
		const drueben = await on(laptop, () => store.loadTimeReport(MONTH));
		expect(drueben?.days).toHaveLength(1);
		expect(drueben?.days[0].hours).toBe(7.5);
	});

	it("legt beim Server nur Chiffrat ab", async () => {
		// Ein Report sagt aus, wann jemand gekommen und gegangen ist. Nichts davon
		// darf im Klartext beim Server liegen.
		const desktop = new FakeDevice("rechner");
		await on(desktop, async (engine) => {
			await store.saveTimeReport(report());
			return engine.sync();
		});
		const line = [...server.rows.values()][0];
		const everything = JSON.stringify(line);
		expect(everything).not.toContain("07:30");
		expect(everything).not.toContain("16:45");
		expect(everything).not.toContain(`${MONTH}-15`);
	});

	it("stellt die Id dem Monat voran, damit sie mit keiner anderen Art zusammenstoesst", async () => {
		// Der Server fuehrt seine Datensaetze allein ueber die Id.
		const desktop = new FakeDevice("rechner");
		await on(desktop, async (engine) => {
			await store.saveTimeReport(report());
			return engine.sync();
		});
		expect([...server.rows.keys()]).toEqual([`timereport:${MONTH}`]);
	});

	it("laedt beim zweiten Durchgang nichts erneut hoch", async () => {
		// Haengt daran, dass loadTimeReport die Fassung mitliest.
		const desktop = new FakeDevice("rechner");
		await on(desktop, async (engine) => {
			await store.saveTimeReport(report());
			return engine.sync();
		});
		const zweiter = await on(desktop, (engine) => engine.sync());
		expect(zweiter!.pushed).toBe(0);
		expect(await on(desktop, () => store.loadTimeReport(MONTH))).toMatchObject({ rev: 1 });
	});

	it("ersetzt drueben den Report, wenn er neu eingelesen wird", async () => {
		const desktop = new FakeDevice("rechner");
		await on(desktop, async (engine) => {
			await store.saveTimeReport(report());
			return engine.sync();
		});
		const laptop = new FakeDevice("laptop");
		await on(laptop, (engine) => engine.sync());

		// Ein neuer Import legt ein frisches Objekt ohne Fassung an - genau so, wie
		// es aus der Datei kommt.
		await afterwards();
		await on(desktop, async (engine) => {
			await store.saveTimeReport(report(MONTH, 9));
			return engine.sync();
		});
		await on(laptop, (engine) => engine.sync());
		const drueben = await on(laptop, () => store.loadTimeReport(MONTH));
		expect(drueben?.days[0].hours).toBe(9);
	});

	it("nimmt den Report drueben weg, wenn er hier geloescht wird", async () => {
		const desktop = new FakeDevice("rechner");
		await on(desktop, async (engine) => {
			await store.saveTimeReport(report());
			return engine.sync();
		});
		const laptop = new FakeDevice("laptop");
		await on(laptop, (engine) => engine.sync());
		expect(await on(laptop, () => store.loadTimeReport(MONTH))).not.toBeNull();

		await afterwards();
		await on(desktop, async (engine) => {
			await store.deleteTimeReport(MONTH);
			return engine.sync();
		});
		await on(laptop, (engine) => engine.sync());
		expect(await on(laptop, () => store.loadTimeReport(MONTH))).toBeNull();
		expect(await on(laptop, () => store.listTimeReportMonths())).toEqual([]);
	});

	it("bleibt auch im schlimmsten Monat unter der Groessengrenze des Servers", async () => {
		// Der Server weist einen Datensatz ueber 64 KB mit 413 ab - und zwar den
		// ganzen Stapel. Ein einziger zu grosser Report legte damit den Abgleich
		// lahm, nicht nur sich selbst.
		const MAX_RECORD_BYTES = 64 * 1024;
		const flags = (["restBreak", "over10", "target10", "gradualReturn", "sunday", "holiday"] as const).map(
			(key) => ({ key, label: "Verstoß Ruhepause", value: "10,25" })
		);
		const days = Array.from({ length: 31 }, (_, i) => ({
			...day(`2026-07-${String(i + 1).padStart(2, "0")}`, 10.25),
			flags
		}));

		const desktop = new FakeDevice("rechner");
		await on(desktop, async (engine) => {
			await store.saveTimeReport({ month: MONTH, importedAt: Date.now(), days });
			return engine.sync();
		});
		const payload = [...server.rows.values()][0].payload ?? "";
		expect(payload.length).toBeGreaterThan(0);
		expect(payload.length).toBeLessThan(MAX_RECORD_BYTES);
	});

	it("nimmt den Report drueben weg, wenn hier das Jahr geloescht wird", async () => {
		// „Einstellungen -> Daten -> Jahr loeschen" nimmt die Reports des Jahres
		// mit. Ginge das am Haken vorbei, holte der naechste Abgleich sie zurueck.
		const desktop = new FakeDevice("rechner");
		await on(desktop, async (engine) => {
			await store.saveTimeReport(report());
			return engine.sync();
		});
		const laptop = new FakeDevice("laptop");
		await on(laptop, (engine) => engine.sync());

		await afterwards();
		await on(desktop, async (engine) => {
			await store.deleteYear(2026);
			return engine.sync();
		});
		await on(laptop, (engine) => engine.sync());
		expect(await on(laptop, () => store.listTimeReportMonths())).toEqual([]);
	});

	it("legt aus einer Loeschung, die wir nie kannten, keine leere Datei an", async () => {
		const desktop = new FakeDevice("rechner");
		await on(desktop, async (engine) => {
			await store.saveTimeReport(report());
			return engine.sync();
		});
		await afterwards();
		await on(desktop, async (engine) => {
			await store.deleteTimeReport(MONTH);
			return engine.sync();
		});

		// Der Laptop war die ganze Zeit weg und sieht nur noch den Loeschmarker.
		const laptop = new FakeDevice("laptop");
		await on(laptop, (engine) => engine.sync());
		expect(await on(laptop, () => store.listTimeReportMonths())).toEqual([]);
	});
});

describe("onProgress – Ladeanzeige beim Massenimport", () => {
	/** Ein Geraet abgleichen lassen und dabei jede Fortschrittsmeldung sammeln. */
	async function syncWithProgress(g: FakeDevice): Promise<{ events: SyncProgress[] }> {
		const events: SyncProgress[] = [];
		await onDevice({ server, key, onProgress: (p) => events.push({ ...p }) }, g, (engine) =>
			engine.sync()
		);
		return { events };
	}

	it("ruft onProgress mit phase=pulling auf, waehrend Eintraege gezogen werden", async () => {
		// Device 1 laedt 25 Eintraege hoch.
		const sender = new FakeDevice("sender");
		const entries25 = Array.from({ length: 25 }, (_, i) =>
			entry(`e${i}`, { startTs: ts(1 + (i % 15), 9 + (i % 8)) })
		);
		await on(sender, async (engine) => {
			await store.saveEntries(MONTH, entries25);
			return engine.sync();
		});

		// Device 2 zieht die 25 Eintraege herunter - onProgress soll firing.
		const recipient = new FakeDevice("empfaenger");
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
		const sender = new FakeDevice("sender2");
		const entries5 = Array.from({ length: 5 }, (_, i) => entry(`f${i}`));
		await on(sender, async (engine) => {
			await store.saveEntries(MONTH, entries5);
			return engine.sync();
		});

		const recipient = new FakeDevice("empfaenger2");
		const { events } = await syncWithProgress(recipient);

		// Kein Event mit pulled >= 20.
		const bulkEvents = events.filter((e) => e.phase === "pulling" && e.pulled >= 20);
		expect(bulkEvents).toHaveLength(0);
	});

	it("meldet die Historie als Hintergrund, den vorgezogenen Teil nicht", async () => {
		// Waehrend des Backfills steht oben das Hinweisband "du kannst schon
		// arbeiten". Ein Modal, das dabei die App zusperrt, widerspricht dem - der
		// Client entscheidet das an dieser Angabe.
		const sender = new FakeDevice("sender-hintergrund");
		const old25 = Array.from({ length: 25 }, (_, i) =>
			entry(`g${i}`, { startTs: ts(1 + (i % 15), 9 + (i % 8)) })
		);
		await on(sender, async (engine) => {
			await store.saveEntries(MONTH, old25);
			return engine.sync();
		});

		const recipient = new FakeDevice("empfaenger-hintergrund");
		recipient.state = { seq: 0, priority: { seq: 0, months: [monthKey(Date.now()), prevMonthKey()] } };
		const { events } = await syncWithProgress(recipient);

		const bulk = events.filter((e) => e.phase === "pulling" && e.pulled >= 20);
		expect(bulk.length).toBeGreaterThan(0);
		expect(bulk.every((e) => e.background === true)).toBe(true);
		// Der vorgezogene Teil laeuft im Vordergrund - dort gehoert das Modal hin.
		expect(events.some((e) => e.phase === "pulling" && !e.background)).toBe(true);
	});

	it("endet immer mit phase=idle", async () => {
		const sender = new FakeDevice("sender3");
		await on(sender, async (engine) => {
			await store.saveEntries(MONTH, [entry("g1")]);
			return engine.sync();
		});

		const recipient = new FakeDevice("empfaenger3");
		const { events } = await syncWithProgress(recipient);

		// Letztes Event muss idle sein.
		expect(events.at(-1)?.phase).toBe("idle");
	});

	it("meldet Fortschritt bei über 200 Einträgen (voller Batch)", async () => {
		const sender = new FakeDevice("sender-bulk");
		const entries250 = Array.from({ length: 250 }, (_, i) =>
			entry(`bulk-${i}`, { startTs: ts(1 + (i % 20), 8 + (i % 8)) })
		);
		await on(sender, async (engine) => {
			await store.saveEntries(MONTH, entries250);
			return engine.sync();
		});

		const recipient = new FakeDevice("empfaenger-bulk");
		const { events } = await syncWithProgress(recipient);

		// Mindestens zwei pulling-Schritte (bei BATCH=200):
		const pullingEvents = events.filter((e) => e.phase === "pulling");
		expect(pullingEvents.length).toBeGreaterThanOrEqual(2);

		const maxPulled = Math.max(...pullingEvents.map((e) => e.pulled));
		expect(maxPulled).toBe(250);
	});
});

describe("Vorgezogenes Laden", () => {
	/**
	 * Ein Monat, der nie der laufende ist - die Tests haengen sonst am Kalendertag,
	 * an dem sie laufen.
	 */
	const OLD = "2020-01";
	const oldTs = (tag: number) => Date.UTC(2020, 0, tag, 9) + 2 * 3600_000;

	/** Die Menge, die ein frisch verknuepftes Device vorzieht - wie in #persistLink. */
	function startState(): SyncState {
		return { seq: 0, priority: { seq: 0, months: [monthKey(Date.now()), prevMonthKey()] } };
	}

	/** Zwei Stunden, die sicher im laufenden Monat liegen. */
	const currentMonthEntry = (id: string) =>
		entry(id, { startTs: Date.now() - 2 * 3600_000, endTs: Date.now() - 3600_000 });

	/** Ein Konto mit Historie, Aktivitaeten und Einstellungen auf dem Server. */
	async function seedServer(): Promise<void> {
		const sender = new FakeDevice("sender");
		await on(sender, async (engine) => {
			await store.saveEntries(OLD, [entry("alt-1", { startTs: oldTs(15) })]);
			await store.saveActivities([
				{ id: "akt-1", name: "Entwicklung", sortOrder: 0, archived: false, isAbsence: false }
			]);
			await store.saveSettings({ ...defaultSettings, hoursPerDay: 7 });
			await store.saveEntries(monthKey(Date.now()), [currentMonthEntry("neu-1")]);
			return engine.sync();
		});
	}

	it("fragt zuerst die vorgezogenen Monate ab und nimmt die ohne Zeitraum mit", async () => {
		await seedServer();
		const laptop = new FakeDevice("laptop");
		laptop.state = startState();
		server.queries = [];
		await on(laptop, (engine) => engine.sync());

		const firstCall = server.queries.find((q) => q.startsWith("GET /api/sync?"))!;
		const params = new URLSearchParams(firstCall.split("?")[1]);
		expect(params.getAll("bucket")).toHaveLength(2);
		expect(params.get("unbucketed")).toBe("1");
		expect(params.get("since")).toBe("0");
	});

	it("bringt Aktivitaeten und Einstellungen im vorgezogenen Teil mit", async () => {
		// Ohne sie stuende die Oberflaeche ohne Namen und ohne Sollstunden da.
		await seedServer();
		const laptop = new FakeDevice("laptop");
		laptop.state = startState();
		await on(laptop, (engine) => engine.sync());

		const activities = await on(laptop, () => store.loadActivities());
		const settings = await on(laptop, () => store.loadSettings());
		expect(activities.map((a) => a.name)).toEqual(["Entwicklung"]);
		expect(settings.hoursPerDay).toBe(7);
	});

	it("legt den vorgezogenen Teil ab, sobald die Historie durch ist", async () => {
		await seedServer();
		const laptop = new FakeDevice("laptop");
		laptop.state = startState();
		await on(laptop, (engine) => engine.sync());

		expect(laptop.state.priority).toBeUndefined();
		expect((await entries(laptop, OLD)).map((e) => e.id)).toEqual(["alt-1"]);
	});

	it("holt einen alten Monat auf Zuruf, ohne die Historie zu durchlaufen", async () => {
		await seedServer();
		const laptop = new FakeDevice("laptop");
		laptop.state = startState();
		server.queries = [];
		await on(laptop, (engine) => engine.ensureMonthSynced(OLD));

		// Genau eine Anfrage, und die nur fuer diesen einen Zeitraum.
		const pulls = server.queries.filter((q) => q.startsWith("GET /api/sync?"));
		expect(pulls).toHaveLength(1);
		const params = new URLSearchParams(pulls[0].split("?")[1]);
		expect(params.getAll("bucket")).toHaveLength(1);
		expect(params.get("unbucketed")).toBeNull();
		expect((await entries(laptop, OLD)).map((e) => e.id)).toEqual(["alt-1"]);
	});

	it("nimmt einen nachgeladenen Monat auf, ohne den gemeinsamen Stand vorzuziehen", async () => {
		// Der Stand darf hinterher sein - dann kommt der Monat noch einmal, was
		// nichts kostet. Vorziehen wuerde ueberspringen, was die anderen Monate
		// noch nicht kennen.
		await seedServer();
		const laptop = new FakeDevice("laptop");
		laptop.state = startState();
		await on(laptop, (engine) => engine.ensureMonthSynced(OLD));

		expect(laptop.state.priority?.months).toContain(OLD);
		expect(laptop.state.priority?.seq).toBe(0);
		expect(laptop.state.seq).toBe(0);
	});

	it("nach dem Backfill kostet ein Nachladen keine Anfrage mehr", async () => {
		await seedServer();
		const laptop = new FakeDevice("laptop");
		laptop.state = startState();
		await on(laptop, (engine) => engine.sync());
		server.queries = [];
		await on(laptop, (engine) => engine.ensureMonthSynced("2019-05"));
		expect(server.queries).toEqual([]);
	});

	it("zweimal Nachladen laedt nur einmal", async () => {
		// Der Prefetch beim Hovern feuert sonst bei jeder Mausbewegung erneut.
		await seedServer();
		const laptop = new FakeDevice("laptop");
		laptop.state = startState();
		server.queries = [];
		await on(laptop, (engine) =>
			Promise.all([engine.ensureMonthSynced(OLD), engine.ensureMonthSynced(OLD)])
		);
		expect(server.queries.filter((q) => q.startsWith("GET /api/sync?"))).toHaveLength(1);
	});

	it("die Historie setzt aus, solange ein Monat auf Zuruf laeuft", async () => {
		// Spekulation darf die Leitung nicht zumachen, die einer braucht, der
		// gerade hinsieht. Ausgesetzt wird nur, nicht gewartet - sonst hielten
		// sich beide gegenseitig auf.
		await seedServer();
		const laptop = new FakeDevice("laptop");
		laptop.state = startState();

		await on(laptop, async (engine) => {
			server.hold("bucket");
			// Laeuft los und bleibt am Tor stehen.
			const fetching = engine.ensureMonthSynced(OLD);
			const before = laptop.state.seq;
			await engine.sync();
			expect(engine.seq).toBe(before);

			server.release();
			await fetching;
		});

		// Und danach laeuft sie wieder.
		await on(laptop, (engine) => engine.sync());
		expect(laptop.state.seq).toBeGreaterThan(0);
	});

	it("nach stop() spielt eine laufende Runde nichts mehr ein", async () => {
		// Beim Abmelden ist ein Abruf unterwegs. Seine Seite kommt an, wenn der
		// lokale Bestand geloescht ist - ohne stop() schreibt er ihn zurueck.
		await seedServer();
		const laptop = new FakeDevice("laptop");
		laptop.state = startState();

		await on(laptop, async (engine) => {
			server.hold("bucket");
			const fetching = engine.ensureMonthSynced(OLD);

			engine.stop();
			server.release();
			await fetching;

			expect(await store.loadEntries(OLD)).toEqual([]);
			// Und eine neue Runde faengt gar nicht erst an.
			expect(await engine.sync()).toBeNull();
		});
	});

	it("ein Device ohne vorgezogenen Teil holt weiterhin alles am Stueck", async () => {
		// Bestandsgeraete kennen schon alles; fuer sie darf sich nichts aendern.
		await seedServer();
		const laptop = new FakeDevice("laptop");
		server.queries = [];
		await on(laptop, (engine) => engine.sync());

		const pulls = server.queries.filter((q) => q.startsWith("GET /api/sync?"));
		expect(pulls.every((q) => !q.includes("bucket="))).toBe(true);
		expect((await entries(laptop, OLD)).map((e) => e.id)).toEqual(["alt-1"]);
	});
});
