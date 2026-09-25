// Zwei Geräte an einem Konto - der ganze Weg.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeSyncServer } from "../testing/fakeSyncServer";
import { FakeDevice, onDevice, withoutAccount } from "../testing/syncDevice";
import type { VaultKey } from "../crypto/vault";

vi.mock("@tauri-apps/plugin-fs", async () => (await import("../testing/fakeFs")).fakeFs);

const { createVaultKey, bucketFor } = await import("../crypto/vault");
const { monthKey, prevMonthKey, startOfNextDay } = await import("../time/time");
const { resetOutboxForTests, pendingChanges } = await import("./outbox");
const { resetFakeFs } = await import("../testing/fakeFs");
const store = await import("../store");
const { defaultSettings } = await import("../types");
import type { Entry } from "../types";
import { anEntry, MONTH, ts } from "../testing/fixtures";
import type { SyncEngine, SyncProgress, SyncState } from "./engine";

let server: FakeSyncServer;
let key: VaultKey;

const on = <T,>(g: FakeDevice, fn: (engine: SyncEngine) => Promise<T>): Promise<T> =>
	onDevice({ server, key }, g, fn);


const entry = (id: string, over: Partial<Entry> = {}): Entry =>
	anEntry(id, { activityId: "akt-1", startTs: ts(15, 9), endTs: ts(15, 12), ...over });

/**
 * Warten, bis die Uhr weiterspringt.
 *
 * Bei gleichem `updatedAt` entscheidet die Gerätekennung statt der Reihenfolge -
 * derselbe Test fiele sonst mal so und mal so aus.
 */
async function afterwards(): Promise<void> {
	const now = Date.now();
	while (Date.now() === now) await new Promise((r) => setTimeout(r, 1));
}

/** Auf einem Gerät etwas ändern und gleich abgleichen. */
const changeAndSync = (g: FakeDevice, change: () => Promise<unknown>) =>
	on(g, async (engine) => {
		await change();
		return engine.sync();
	});

/** Ein Gerät, das die genannten Einträge hochgeladen hat. */
async function deviceWith(id: string, ...list: Entry[]): Promise<FakeDevice> {
	const device = new FakeDevice(id);
	await changeAndSync(device, () => store.saveEntries(MONTH, list));
	return device;
}

/** Ein Handy mit einem hochgeladenen Eintrag - die Ausgangslage vieler Fälle. */
const phoneWith = (e: Entry) => deviceWith("handy", e);

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
		const phone = await deviceWith("handy", entry("e1", { note: "Kundengespräch" }));
		const line = [...server.rows.values()][0];
		const everything = JSON.stringify(line);
		expect(everything).not.toContain("Kundengespräch");
		expect(everything).not.toContain("akt-1");
		expect(everything).not.toContain(String(ts(15, 9)));
		// Der verschleierte Zeitraum verrät den Monat nicht.
		expect(line.bucket).not.toContain("2026-08");
		expect(line.bucket).toMatch(/^[0-9a-f]{32}$/);
	});

	it("schreibt die Fassung des Servers auf die Platte zurueck", async () => {
		// Daran hängt alles Weitere: eine Folgeänderung wird nur angenommen, wenn
		// sie auf der Fassung des Servers aufsetzt.
		const phone = await deviceWith("handy", entry("e1"));
		expect((await entries(phone))[0].rev).toBe(1);
	});

	it("laedt beim zweiten Durchgang nichts erneut hoch", async () => {
		const phone = await deviceWith("handy", entry("e1"));
		const before = server.seq;
		const secondOne = await on(phone, (engine) => engine.sync());
		expect(secondOne!.pushed).toBe(0);
		expect(server.seq).toBe(before);
	});
});

describe("Zwei Geraete", () => {
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

		// Das Handy löscht. Der Vergleich beim Schreiben erkennt die Löschung
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
		// Beide ändern denselben Eintrag, ohne voneinander zu wissen.
		const phone = await phoneWith(entry("e1", { note: "handy" }));
		const desktop = new FakeDevice("rechner");
		await on(desktop, (engine) => engine.sync());

		// Der Rechner ändert - auf dem Stand, den er kennt, und nachweislich später.
		await afterwards();
		await on(desktop, async (engine) => {
			const theirs = (await store.loadEntries(MONTH))[0];
			await store.saveEntries(MONTH, [{ ...theirs, note: "rechner" }]);
			return engine.sync();
		});

		// Das Handy holt und sieht die jüngere Fassung.
		await on(phone, (engine) => engine.sync());
		expect((await entries(phone))[0].note).toBe("rechner");
	});

	it("loest einen Konflikt aus der Antwort, ohne die Historie zu ziehen", async () => {
		// Der Server schickt den Stand, an dem es gescheitert ist, ohnehin mit.
		// Ihn zu nehmen kostet nichts; die Historie dafür durchzublättern kann
		// auf einem Konto mit Jahren an Daten eine ganze Weile dauern.
		const phone = await phoneWith(entry("e1", { note: "handy" }));
		const desktop = new FakeDevice("rechner");
		await on(desktop, (engine) => engine.sync());

		// Das Handy ändert denselben Eintrag - damit steht der Rechner auf einer
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

		// Der Rechner ändert auf seinem alten Stand und läuft damit in den Konflikt.
		await afterwards();
		server.calls.length = 0;
		const result = await on(desktop, async (engine) => {
			const theirs = (await store.loadEntries(MONTH))[0];
			await store.saveEntries(MONTH, [{ ...theirs, note: "rechner" }]);
			return engine.sync();
		});

		// Die Änderung ist durch - darum geht es zuerst.
		expect(result!.pushed).toBe(1);
		expect([...server.rows.values()].find((r) => r.id === "e1")!.rev).toBe(3);

		// Und zwar OHNE Abruf dazwischen: der zweite Versuch folgt direkt auf den
		// ersten. Ein Abruf an dieser Stelle zöge die ganze Historie und risse
		// damit das Budget ein, das der gestaffelte Abgleich setzt.
		const first = server.calls.indexOf("POST /api/sync");
		const second = server.calls.indexOf("POST /api/sync", first + 1);
		expect(second).toBeGreaterThan(first);
		expect(server.calls.slice(first, second)).not.toContain("GET /api/sync");
	});

	it("haengt nicht endlos an einer Loeschung, die der Server schon kennt", async () => {
		// Beide löschen denselben Eintrag, der Rechner offline. Seine Löschung
		// trägt danach eine Fassung, die der Server nicht mehr hat - und anders
		// als bei einem Eintrag, der noch liegt, gibt es lokal nichts mehr, worin
		// die Fassung des Servers ankommen könnte.
		const phone = await phoneWith(entry("e1"));
		const desktop = new FakeDevice("rechner");
		await on(desktop, (engine) => engine.sync());

		await withoutAccount(desktop, () => store.saveOutbox([
			{ kind: "entry", id: "e1", month: MONTH, deleted: true, rev: 1, at: Date.now() }
		]));
		await withoutAccount(desktop, async () => {
			await store.saveEntries(MONTH, []);
		});

		await afterwards();
		await on(phone, async (engine) => {
			await store.saveEntries(MONTH, []);
			return engine.sync();
		});

		const result = await on(desktop, (engine) => engine.sync());
		// Erledigt ist erledigt: die Löschung verlässt die Merkliste, statt in
		// jedem Durchgang aufs Neue abgelehnt zu werden.
		expect(await on(desktop, async () => pendingChanges())).toEqual([]);

		server.calls.length = 0;
		const again = await on(desktop, (engine) => engine.sync());
		expect(again!.pulled).toBe(0);
		expect(server.calls).not.toContain("POST /api/sync");
		expect(result!.pushed).toBe(0);
	});

	it("laesst hoechstens einen Timer laufen, wenn beide Geraete einen halten", async () => {
		// Der Fall, um den es dem Nutzer geht: am Handy gestartet, der Rechner
		// wacht auf und weiss nichts davon.
		await phoneWith(entry("h1", { endTs: null, startTs: ts(15, 9) }));

		const desktop = new FakeDevice("rechner");
		await on(desktop, async (engine) => {
			// Der Rechner startet seinerseits - später, also ist das die jüngere
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

	it("schliesst keinen laufenden Timer, nur weil beim Start eine Mitternachts-Teilung dazukam", async () => {
		// Der Fall aus dem Betrieb: der Rechner startet morgens mit einem Lauf von
		// gestern, den ein anderes Geraet laengst beendet hat, und teilt ihn an der
		// Tagesgrenze. Die Fortsetzung ist Sekunden alt - nach dem Stempel gewaenne
		// sie, und der Timer, der gerade wirklich laeuft, fiele auf Dauer null
		// zusammen.
		const midnight = startOfNextDay(ts(15, 9));
		const desktop = await deviceWith("rechner", entry("d1", { startTs: ts(15, 9), endTs: null }));

		// Das Handy beendet den Lauf gestern Abend und startet heute frueh einen
		// eigenen. Beides steht auf dem Server, der Rechner weiss von nichts.
		const phone = new FakeDevice("handy");
		await on(phone, (engine) => engine.sync());
		await afterwards();
		await changeAndSync(phone, async () => {
			const list = await store.loadEntries(MONTH);
			await store.saveEntries(MONTH, [
				...list.map((e) => (e.id === "d1" ? { ...e, endTs: ts(15, 18) } : e)),
				entry("h1", { startTs: ts(16, 8), endTs: null })
			]);
		});

		// Der Rechner erlebt derweil offline Mitternacht und teilt seinen Lauf.
		await afterwards();
		await on(desktop, async () => {
			const list = await store.loadEntries(MONTH);
			await store.saveEntries(MONTH, [
				...list.map((e) => (e.id === "d1" ? { ...e, endTs: midnight } : e)),
				entry("d2", { startTs: midnight, endTs: null })
			]);
		});

		await on(desktop, (engine) => engine.sync());

		const list = await entries(desktop);
		// Der Lauf vom Handy laeuft weiter - er ist gestartet worden, die
		// Fortsetzung ist bloss gebucht.
		expect(list.find((e) => e.id === "h1")!.endTs).toBeNull();
		// Die Fortsetzung endet an ihrem eigenen Start: keine erfundenen acht
		// Stunden bis zum Start des echten Laufs.
		expect(list.find((e) => e.id === "d2")!.endTs).toBe(midnight);

		// Und das Handy behaelt seinen laufenden Timer - hier faellt sonst auf,
		// dass der Rechner ihn dem ganzen Konto weggeschlossen hat.
		await on(phone, (engine) => engine.sync());
		expect((await entries(phone)).find((e) => e.id === "h1")!.endTs).toBeNull();
	});

	it("sagt dem Server, welchen Timer es geschlossen hat", async () => {
		// Zwei echte Laeufe, einer muss weichen. Das ist eine Entscheidung dieses
		// Geraets, kein Serverstand - bliebe sie hier liegen, liefe der Timer auf
		// dem anderen Geraet weiter und beide Staende gingen still auseinander.
		const phone = await phoneWith(entry("h1", { endTs: null, startTs: ts(15, 9) }));

		const desktop = new FakeDevice("rechner");
		await on(desktop, async (engine) => {
			await store.saveEntries(MONTH, [entry("r1", { endTs: null, startTs: ts(15, 14) })]);
			return engine.sync();
		});

		expect(await on(desktop, async () => pendingChanges().map((c) => c.id))).toContain("h1");

		await on(desktop, (engine) => engine.sync());
		await on(phone, (engine) => engine.sync());
		expect((await entries(phone)).find((e) => e.id === "h1")!.endTs).toBe(ts(15, 14));
	});

	it("beendet eine offline entstandene Mitternachts-Fortsetzung nicht einfach selbst, wenn der Server den Lauf laengst frueher geschlossen hat", async () => {
		// Die Tagesgrenze in der Zeitzone der App, nicht der der Testdaten.
		const midnight = startOfNextDay(ts(15, 9));
		// Der Rechner startet einen Timer und synct - Server und Rechner kennen
		// d1 offen.
		const desktop = await deviceWith("rechner", entry("d1", { startTs: ts(15, 9), endTs: null }));

		// Das Handy zieht den Stand und beendet den Lauf noch am selben Tag um
		// 17 Uhr - eine echte, bewusste Handlung - und synct das hoch.
		const phone = new FakeDevice("handy");
		await on(phone, (engine) => engine.sync());
		await afterwards();
		await changeAndSync(phone, async () => {
			const list = await store.loadEntries(MONTH);
			await store.saveEntries(
				MONTH,
				list.map((e) => (e.id === "d1" ? { ...e, endTs: ts(15, 17) } : e))
			);
		});

		// Der Rechner bleibt die ganze Zeit offline: er erlebt lokal Mitternacht
		// und teilt den Lauf, ohne vom Handy je etwas mitzubekommen.
		await afterwards();
		await on(desktop, async () => {
			const list = await store.loadEntries(MONTH);
			const split = list.map((e) => (e.id === "d1" ? { ...e, endTs: midnight } : e));
			split.push(entry("d2", { startTs: midnight, endTs: null }));
			await store.saveEntries(MONTH, split);
		});

		// Jetzt kommt der Rechner wieder online.
		const outcome = await on(desktop, (engine) => engine.sync());

		const list = await entries(desktop);
		// Die echte Endzeit vom Handy gilt - nicht die Mitternachts-Teilung, die
		// bloss lokale Buchfuehrung ohne Kenntnis vom echten Ende war. Ohne diese
		// Regel gewinnt die Teilung rein zufaellig, weil ihr Stempel erst beim
		// Wieder-online-Kommen entsteht und damit spaeter liegt als die echte,
		// laengst hochgeladene Handlung vom Handy.
		expect(list.find((e) => e.id === "d1")!.endTs).toBe(ts(15, 17));
		// d2 bleibt unangetastet stehen, statt geraten zu werden: vielleicht hat
		// der Nutzer ab Mitternacht tatsaechlich weitergearbeitet, ohne den Timer
		// neu zu starten. Das kann nur ein Mensch entscheiden.
		expect(list.find((e) => e.id === "d2")!.endTs).toBeNull();
		// Stattdessen wird es gemeldet, damit die Oberflaeche einen Hinweis zeigt -
		// mitsamt beiden Einträgen, damit sie sich dort auswählen lassen.
		expect(outcome?.staleTimerSplits).toHaveLength(1);
		expect(outcome?.staleTimerSplits[0].endedEntry.id).toBe("d1");
		expect(outcome?.staleTimerSplits[0].endedEntry.endTs).toBe(ts(15, 17));
		expect(outcome?.staleTimerSplits[0].continuationEntry.id).toBe("d2");
	});

	it("meldet keine Teilung, wenn der Lauf woanders noch offen ist und nur die Notiz geändert wurde", async () => {
		const midnight = startOfNextDay(ts(15, 9));
		const desktop = await deviceWith("rechner", entry("d1", { startTs: ts(15, 9), endTs: null }));

		// Das Handy ergänzt nur eine Notiz - der Lauf ist dort weiter offen.
		const phone = new FakeDevice("handy");
		await on(phone, (engine) => engine.sync());
		await afterwards();
		await changeAndSync(phone, async () => {
			const list = await store.loadEntries(MONTH);
			await store.saveEntries(MONTH, list.map((e) => (e.id === "d1" ? { ...e, note: "vom Handy" } : e)));
		});

		await afterwards();
		await on(desktop, async () => {
			const list = await store.loadEntries(MONTH);
			const split = list.map((e) => (e.id === "d1" ? { ...e, endTs: midnight } : e));
			split.push(entry("d2", { startTs: midnight, endTs: null }));
			await store.saveEntries(MONTH, split);
		});

		const outcome = await on(desktop, (engine) => engine.sync());

		// Nichts zu prüfen: niemand hat den Lauf früher beendet.
		expect(outcome?.staleTimerSplits).toEqual([]);
	});

	it("meldet keine stehen gebliebene Teilung, wenn der Server dieselbe Endzeit hat", async () => {
		const midnight = startOfNextDay(ts(15, 9));
		const desktop = await deviceWith("rechner", entry("d1", { startTs: ts(15, 9), endTs: null }));

		// Das Handy beendet den Lauf exakt um Mitternacht - dieselbe Endzeit wie die
		// Teilung des Rechners - und ergaenzt eine Notiz.
		const phone = new FakeDevice("handy");
		await on(phone, (engine) => engine.sync());
		await afterwards();
		await changeAndSync(phone, async () => {
			const list = await store.loadEntries(MONTH);
			await store.saveEntries(
				MONTH,
				list.map((e) => (e.id === "d1" ? { ...e, endTs: midnight, note: "vom Handy" } : e))
			);
		});

		await afterwards();
		await on(desktop, async () => {
			const list = await store.loadEntries(MONTH);
			const split = list.map((e) => (e.id === "d1" ? { ...e, endTs: midnight } : e));
			split.push(entry("d2", { startTs: midnight, endTs: null }));
			await store.saveEntries(MONTH, split);
		});

		const outcome = await on(desktop, (engine) => engine.sync());

		expect((await entries(desktop)).find((e) => e.id === "d1")!.note).toBe("vom Handy");
		expect(outcome?.staleTimerSplits).toEqual([]);
	});

	it("haelt eine eigene Endzeit-Aenderung, auch wenn direkt danach ein unversendeter Eintrag beginnt", async () => {
		// Keine Mitternachts-Teilung: zwei aufeinanderfolgende Eintraege mitten am Tag.
		const desktop = await deviceWith("rechner", entry("d1", { startTs: ts(15, 9), endTs: ts(15, 12) }));

		const phone = new FakeDevice("handy");
		await on(phone, (engine) => engine.sync());
		await afterwards();
		await changeAndSync(phone, async () => {
			const list = await store.loadEntries(MONTH);
			await store.saveEntries(
				MONTH,
				list.map((e) => (e.id === "d1" ? { ...e, note: "vom Handy" } : e))
			);
		});

		await afterwards();
		await on(desktop, async () => {
			const list = await store.loadEntries(MONTH);
			const edited = list.map((e) => (e.id === "d1" ? { ...e, endTs: ts(15, 11) } : e));
			edited.push(entry("d2", { startTs: ts(15, 11), endTs: ts(15, 13) }));
			await store.saveEntries(MONTH, edited);
		});

		const outcome = await on(desktop, (engine) => engine.sync());

		expect((await entries(desktop)).find((e) => e.id === "d1")!.endTs).toBe(ts(15, 11));
		expect(outcome?.staleTimerSplits).toEqual([]);
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
		await changeAndSync(phone, () => store.saveSettings({ ...defaultSettings, hoursPerDay: 8, timeZone: "Europe/Berlin" }));

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

/** Ein Zeitstempel im Folgemonat - für alles, was über die Monatsgrenze geht. */
const tsAug = (day: number, hour: number) => Date.UTC(2026, 7, day, hour) + 2 * 3600_000;

/** Eine Löschung beim Server nachstellen, ohne ein Device dafür zu bemühen. */
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
		// Der Weg, den updateEntry geht, wenn jemand das Datum über den
		// Monatswechsel zieht: der alte Monat wird ohne ihn gespeichert, der neue
		// mit ihm. In der Outbox bleibt davon EINE Änderung stehen (die spätere
		// gewinnt), der Server sieht also nie eine Löschung - das andere Device
		// muss den Umzug am neuen Startzeitpunkt selbst erkennen.
		const phone = await deviceWith("handy", entry("e1"));
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
		// Und NICHT zusätzlich im alten Monat: sonst zählte dieselbe Stunde zweimal.
		expect(await entries(desktop, MONTH)).toEqual([]);
	});

	it("laesst hoechstens einen Timer laufen, auch ueber zwei Monate", async () => {
		// Am Monatsende am Handy gestartet, im nächsten Monat am Rechner noch
		// einmal. Zwei laufende Timer in zwei Dateien - monatsweise betrachtet stand
		// in jeder genau einer, und beide zählten weiter.
		const phone = await deviceWith("handy", entry("h1", { startTs: ts(30, 10), endTs: null }));

		const desktop = new FakeDevice("rechner");
		await changeAndSync(desktop, () => store.saveEntries("2026-08", [entry("r1", { startTs: tsAug(2, 10), endTs: null })]));

		const july = await entries(desktop, MONTH);
		const august = await entries(desktop, "2026-08");
		const open = [...july, ...august].filter((e) => e.endTs === null);
		expect(open.map((e) => e.id)).toEqual(["r1"]);
		// Der Lauf vom Handy ist nicht weg, sondern beendet - dort steckt echte Zeit.
		expect(july.find((e) => e.id === "h1")!.endTs).toBe(tsAug(2, 10));
	});

	it("findet den Monat eines Loeschmarkers, den es beim Start noch nicht gab", async () => {
		// Ein Programm, das läuft und läuft. Die Monatsliste darf ihm nicht
		// einfrieren: sonst fände die Löschung ihren Monat nicht, würde still
		// verworfen - und `seq` liefe trotzdem weiter. Endgültig verloren.
		const phone = await deviceWith("handy", entry("e1"));
		// Ein Löschmarker für etwas, das der Rechner nie hatte. Er ist der Grund,
		// weshalb die Monatsliste im ersten Durchgang überhaupt gezogen wird - zu
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
			// Das Löschen muss durch den Haken gegangen sein, sonst weiss der
			// Abgleich nichts davon.
			expect(pendingChanges()).toEqual([
				expect.objectContaining({ kind: "entry", id: "alt", deleted: true })
			]);
			return engine.sync();
		});

		// Der nächste Durchgang holt es nicht wieder herunter ...
		await on(phone, (engine) => engine.sync());
		expect(await entries(phone, "2025-03")).toEqual([]);
		// ... und das andere Device räumt mit auf.
		await on(desktop, (engine) => engine.sync());
		expect(await entries(desktop, "2025-03")).toEqual([]);
	});
});

describe("Was der Mensch erfahren muss", () => {
	it("zaehlt eine unterlegene eigene Aenderung auch beim Konflikt-Aufloesen", async () => {
		// Der häufigste Weg in einen verlorenen Eigenstand führt genau hier
		// entlang: die eigene Änderung stösst auf einen Konflikt, und beim
		// Auflösen gewinnt der Server. Bliebe die Zahl dort liegen, stünde am Ende
		// "abgeglichen" da - ohne ein Wort darüber, dass etwas überschrieben wurde.
		const phone = await deviceWith("handy", entry("e1", { note: "handy" }));
		const desktop = new FakeDevice("rechner");
		await on(desktop, (engine) => engine.sync());

		// Das Handy ändert und lädt hoch - und zwar nachweislich später, damit
		// der Wettstreit nicht an einer Millisekunde hängt.
		await on(phone, async (engine) => {
			const theirs = (await store.loadEntries(MONTH))[0];
			await store.saveEntries(MONTH, [{ ...theirs, note: "handy zwei" }]);
			return engine.sync();
		});
		const line = server.rows.get("e1")!;
		server.rows.set("e1", { ...line, updatedAt: Date.now() + 60_000 });

		// Der Rechner ändert auf seinem alten Stand und läuft in den Konflikt.
		const result = await on(desktop, async (engine) => {
			const theirs = (await store.loadEntries(MONTH))[0];
			await store.saveEntries(MONTH, [{ ...theirs, note: "rechner" }]);
			return engine.sync();
		});

		expect(result!.lostEdits).toBe(1);
		expect((await entries(desktop))[0].note).toBe("handy zwei");
	});

	it("raeumt eine unterlegene Einstellungs-Aenderung aus der Outbox auf", async () => {
		// #applySettings schrieb den Serverstand zwar lokal zurueck, hakte die
		// Outbox dabei aber nicht ab - "1 Aenderung ausstehend" blieb stehen,
		// obwohl lokal und Server ab hier identisch waren.
		const phone = new FakeDevice("handy");
		await on(phone, async (engine) => {
			await store.saveSettings({ ...defaultSettings, bossEmail: "erst@firma.de" });
			return engine.sync();
		});
		const desktop = new FakeDevice("rechner");
		await on(desktop, (engine) => engine.sync());

		await on(phone, async (engine) => {
			await store.saveSettings({ ...defaultSettings, bossEmail: "spaeter@firma.de" });
			return engine.sync();
		});
		const row = server.rows.get("settings")!;
		server.rows.set("settings", { ...row, updatedAt: Date.now() + 60_000 });

		const result = await on(desktop, async (engine) => {
			await store.saveSettings({ ...defaultSettings, bossEmail: "rechner@firma.de" });
			return engine.sync();
		});

		expect(result!.lostEdits).toBe(1);
		expect((await on(desktop, () => store.loadSettings())).bossEmail).toBe("spaeter@firma.de");
		expect(pendingChanges()).toEqual([]);
	});
});

describe("Kein Echo", () => {
	it("merkt Eingespieltes nicht als eigene Aenderung vor", async () => {
		// Ohne diese Wache sähe der Schreib-Haken das Einspielen von Serverdaten
		// wie jede andere Änderung und merkte sie vor - der nächste Durchgang
		// lüde sie wieder hoch, wo sie als veraltet abgewiesen würde: ein
		// Device, das dieselben Datensätze im Kreis schickt.
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

		// Und der nächste Durchgang lädt folglich auch nichts hoch.
		const secondOne = await on(desktop, (engine) => engine.sync());
		expect(secondOne!.pushed).toBe(0);
	});
});

describe("Sparsamkeit", () => {
	it("ein Durchgang ohne Aenderungen kostet genau eine Anfrage", async () => {
		// Der Anspruch aus dem Entwurf: im Leerlauf passiert nichts. Wäre hier ein
		// Poller am Werk, stünden hier Dutzende Anfragen.
		const phone = new FakeDevice("handy");
		await on(phone, (engine) => engine.sync());
		server.calls = [];
		await on(phone, (engine) => engine.sync());
		expect(server.calls).toEqual(["GET /api/sync"]);
	});

	it("laesst zwei gleichzeitige Anstoesse nicht nebeneinanderlaufen", async () => {
		// Sonst zögen sie sich gegenseitig die Outbox unter den Füssen weg.
		const phone = new FakeDevice("handy");
		const [a, b] = await on(phone, async (engine) => {
			await store.saveEntries(MONTH, [entry("e1")]);
			return Promise.all([engine.sync(), engine.sync()]);
		});
		// Der zweite Anstoss hängt sich an den laufenden Durchgang, statt ins Leere
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
		// Ein einzelner unlesbarer Datensatz ist ein Ärgernis, ein
		// steckengebliebener Abgleich ein Ausfall.
		const phone = await deviceWith("handy", entry("e1"));

		// Ein Datensatz mit Chiffrat aus einem FREMDEN Vault.
		const otherKey = key;
		key = await createVaultKey();
		const foreign = new FakeDevice("fremd");
		await changeAndSync(foreign, () => store.saveEntries("2026-08", [entry("e2", { startTs: ts(20, 9) })]));
		key = otherKey;

		// Ein Device mit dem RICHTIGEN Schlüssel bekommt e1 und überspringt e2.
		const desktop = new FakeDevice("rechner");
		await expect(on(desktop, (engine) => engine.sync())).resolves.toBeTruthy();
		expect((await entries(desktop)).map((e) => e.id)).toEqual(["e1"]);
		expect(await entries(desktop, "2026-08")).toEqual([]);
	});

	it("merkt sich den Stand, damit der naechste Durchgang nur das Delta holt", async () => {
		const phone = await deviceWith("handy", entry("e1"));
		const desktop = new FakeDevice("rechner");
		await on(desktop, (engine) => engine.sync());
		expect(desktop.state.seq).toBe(server.seq);
	});
});

describe("Der Server kennt den Bestand nicht mehr", () => {
	// Die Lage nach einem aufgelösten Konto oder einem aus älterer Sicherung
	// wieder aufgesetzten Server: lokal stehen Fassungsnummern, die beim Server
	// niemand kennt. Er antwortet auf jede mit einem Konflikt gegen Fassung 0.

	it("schreibt die Daten neu an, statt fuer immer im Konflikt zu haengen", async () => {
		const pc = new FakeDevice("pc");
		await on(pc, async (engine) => {
			await store.saveEntries(MONTH, [entry("e1"), entry("e2")]);
			await engine.sync();
		});
		expect(server.rows.size).toBe(2);

		// Das Konto wird aufgelöst. Der Server hat nichts mehr - das Device weiss
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
		// auf die Fassung, die daraus wird. Wird die Fassung auf 0 zurückgesetzt,
		// MUSS das vor dem Versiegeln passieren - sonst ist die Bindung falsch,
		// und das Chiffrat lässt sich nirgends mehr öffnen. Ein zweites Device
		// ist der einzige ehrliche Beleg dafür.
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
		// Die Merkliste darf nicht dazu führen, dass später mit Fassung 0
		// geschrieben wird, wo der Server sehr wohl etwas hat - das würde die
		// Arbeit des anderen Geräts überschreiben, ohne sie gesehen zu haben.
		const pc = new FakeDevice("pc");
		const phone = new FakeDevice("handy");

		await on(pc, async (engine) => {
			await store.saveEntries(MONTH, [entry("e1", { note: "vom PC" })]);
			await engine.sync();
		});
		await on(phone, (engine) => engine.sync());

		// Beide ändern, ohne voneinander zu wissen.
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

		// Die Fassung ist ordentlich weitergezählt - nichts wurde überschrieben,
		// ohne den Zwischenstand gesehen zu haben.
		expect(server.rows.get("e1")?.rev).toBe(3);
	});
});

describe("Eingelesene Reports", () => {
	/** Ein Rechner mit hochgeladenem Report - und ein Laptop, der ihn schon hat. */
	async function reportOnBoth(): Promise<{ desktop: FakeDevice; laptop: FakeDevice }> {
		const desktop = new FakeDevice("rechner");
		await changeAndSync(desktop, () => store.saveTimeReport(report()));
		const laptop = new FakeDevice("laptop");
		await on(laptop, (engine) => engine.sync());
		return { desktop, laptop };
	}

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
		await changeAndSync(desktop, () => store.saveTimeReport(report()));

		const laptop = new FakeDevice("laptop");
		await on(laptop, (engine) => engine.sync());
		const onLaptop = await on(laptop, () => store.loadTimeReport(MONTH));
		expect(onLaptop?.days).toHaveLength(1);
		expect(onLaptop?.days[0].hours).toBe(7.5);
	});

	it("legt beim Server nur Chiffrat ab", async () => {
		// Ein Report sagt aus, wann jemand gekommen und gegangen ist. Nichts davon
		// darf im Klartext beim Server liegen.
		const desktop = new FakeDevice("rechner");
		await changeAndSync(desktop, () => store.saveTimeReport(report()));
		const line = [...server.rows.values()][0];
		const everything = JSON.stringify(line);
		expect(everything).not.toContain("07:30");
		expect(everything).not.toContain("16:45");
		expect(everything).not.toContain(`${MONTH}-15`);
	});

	it("stellt die Id dem Monat voran, damit sie mit keiner anderen Art zusammenstoesst", async () => {
		// Der Server führt seine Datensätze allein über die Id.
		const desktop = new FakeDevice("rechner");
		await changeAndSync(desktop, () => store.saveTimeReport(report()));
		expect([...server.rows.keys()]).toEqual([`timereport:${MONTH}`]);
	});

	it("laedt beim zweiten Durchgang nichts erneut hoch", async () => {
		// Hängt daran, dass loadTimeReport die Fassung mitliest.
		const desktop = new FakeDevice("rechner");
		await changeAndSync(desktop, () => store.saveTimeReport(report()));
		const secondRun = await on(desktop, (engine) => engine.sync());
		expect(secondRun!.pushed).toBe(0);
		expect(await on(desktop, () => store.loadTimeReport(MONTH))).toMatchObject({ rev: 1 });
	});

	it("ersetzt drueben den Report, wenn er neu eingelesen wird", async () => {
		const { desktop, laptop } = await reportOnBoth();

		// Ein neuer Import legt ein frisches Objekt ohne Fassung an - genau so, wie
		// es aus der Datei kommt.
		await afterwards();
		await changeAndSync(desktop, () => store.saveTimeReport(report(MONTH, 9)));
		await on(laptop, (engine) => engine.sync());
		const onLaptop = await on(laptop, () => store.loadTimeReport(MONTH));
		expect(onLaptop?.days[0].hours).toBe(9);
	});

	it("nimmt den Report drueben weg, wenn er hier geloescht wird", async () => {
		const { desktop, laptop } = await reportOnBoth();
		expect(await on(laptop, () => store.loadTimeReport(MONTH))).not.toBeNull();

		await afterwards();
		await changeAndSync(desktop, () => store.deleteTimeReport(MONTH));
		await on(laptop, (engine) => engine.sync());
		expect(await on(laptop, () => store.loadTimeReport(MONTH))).toBeNull();
		expect(await on(laptop, () => store.listTimeReportMonths())).toEqual([]);
	});

	it("bleibt auch im schlimmsten Monat unter der Groessengrenze des Servers", async () => {
		// Der Server weist einen Datensatz über 64 KB mit 413 ab - und zwar den
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
		await changeAndSync(desktop, () => store.saveTimeReport({ month: MONTH, importedAt: Date.now(), days }));
		const payload = [...server.rows.values()][0].payload ?? "";
		expect(payload.length).toBeGreaterThan(0);
		expect(payload.length).toBeLessThan(MAX_RECORD_BYTES);
	});

	it("nimmt den Report drueben weg, wenn hier das Jahr geloescht wird", async () => {
		// „Einstellungen -> Daten -> Jahr löschen“ nimmt die Reports des Jahres
		// mit. Ginge das am Haken vorbei, holte der nächste Abgleich sie zurück.
		const { desktop, laptop } = await reportOnBoth();

		await afterwards();
		await changeAndSync(desktop, () => store.deleteYear(2026));
		await on(laptop, (engine) => engine.sync());
		expect(await on(laptop, () => store.listTimeReportMonths())).toEqual([]);
	});

	it("legt aus einer Loeschung, die wir nie kannten, keine leere Datei an", async () => {
		const desktop = new FakeDevice("rechner");
		await changeAndSync(desktop, () => store.saveTimeReport(report()));
		await afterwards();
		await changeAndSync(desktop, () => store.deleteTimeReport(MONTH));

		// Der Laptop war die ganze Zeit weg und sieht nur noch den Löschmarker.
		const laptop = new FakeDevice("laptop");
		await on(laptop, (engine) => engine.sync());
		expect(await on(laptop, () => store.listTimeReportMonths())).toEqual([]);
	});
});

describe("onProgress – Ladeanzeige beim Massenimport", () => {
	/** Ein Gerät abgleichen lassen und dabei jede Fortschrittsmeldung sammeln. */
	async function syncWithProgress(g: FakeDevice): Promise<{ events: SyncProgress[] }> {
		const events: SyncProgress[] = [];
		await onDevice({ server, key, onProgress: (p) => events.push({ ...p }) }, g, (engine) =>
			engine.sync()
		);
		return { events };
	}

	it("ruft onProgress mit phase=pulling auf, waehrend Eintraege gezogen werden", async () => {
		// Device 1 lädt 25 Einträge hoch.
		const sender = new FakeDevice("sender");
		const entries25 = Array.from({ length: 25 }, (_, i) =>
			entry(`e${i}`, { startTs: ts(1 + (i % 15), 9 + (i % 8)) })
		);
		await changeAndSync(sender, () => store.saveEntries(MONTH, entries25));

		// Device 2 zieht die 25 Einträge herunter - onProgress soll firing.
		const recipient = new FakeDevice("empfaenger");
		const { events } = await syncWithProgress(recipient);

		// Es muss mindestens ein Event mit phase=pulling und pulled>=20 geben.
		const bulkEvents = events.filter((e) => e.phase === "pulling" && e.pulled >= 20);
		expect(bulkEvents.length).toBeGreaterThan(0);

		// Der finale pulled-Zähler muss 25 betragen.
		const lastPull = [...events].reverse().find((e) => e.phase === "pulling");
		expect(lastPull?.pulled).toBe(25);
	});

	it("ruft onProgress NICHT mit pulled>=20 auf, wenn weniger als 20 Eintraege kommen", async () => {
		// Nur 5 Einträge hochladen.
		const sender = new FakeDevice("sender2");
		const entries5 = Array.from({ length: 5 }, (_, i) => entry(`f${i}`));
		await changeAndSync(sender, () => store.saveEntries(MONTH, entries5));

		const recipient = new FakeDevice("empfaenger2");
		const { events } = await syncWithProgress(recipient);

		// Kein Event mit pulled >= 20.
		const bulkEvents = events.filter((e) => e.phase === "pulling" && e.pulled >= 20);
		expect(bulkEvents).toHaveLength(0);
	});

	it("meldet die Historie als Hintergrund, den vorgezogenen Teil nicht", async () => {
		// Während des Backfills steht oben das Hinweisband "du kannst schon
		// arbeiten". Ein Modal, das dabei die App zusperrt, widerspricht dem - der
		// Client entscheidet das an dieser Angabe.
		const sender = new FakeDevice("sender-hintergrund");
		const old25 = Array.from({ length: 25 }, (_, i) =>
			entry(`g${i}`, { startTs: ts(1 + (i % 15), 9 + (i % 8)) })
		);
		await changeAndSync(sender, () => store.saveEntries(MONTH, old25));

		const recipient = new FakeDevice("empfaenger-hintergrund");
		recipient.state = { seq: 0, priority: { seq: 0, months: [monthKey(Date.now()), prevMonthKey()] } };
		const { events } = await syncWithProgress(recipient);

		const bulk = events.filter((e) => e.phase === "pulling" && e.pulled >= 20);
		expect(bulk.length).toBeGreaterThan(0);
		expect(bulk.every((e) => e.background === true)).toBe(true);
		// Der vorgezogene Teil läuft im Vordergrund - dort gehört das Modal hin.
		expect(events.some((e) => e.phase === "pulling" && !e.background)).toBe(true);
	});

	it("endet immer mit phase=idle", async () => {
		const sender = await deviceWith("sender3", entry("g1"));

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
		await changeAndSync(sender, () => store.saveEntries(MONTH, entries250));

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
	/** Ein Laptop, das den vorgezogenen Teil vor sich hat - Server schon gefüllt. */
	async function laptopAtStart(): Promise<FakeDevice> {
		await seedServer();
		const laptop = new FakeDevice("laptop");
		laptop.state = startState();
		return laptop;
	}

	/**
	 * Ein Monat, der nie der laufende ist - die Tests hängen sonst am Kalendertag,
	 * an dem sie laufen.
	 */
	const OLD = "2020-01";
	const oldTs = (tag: number) => Date.UTC(2020, 0, tag, 9) + 2 * 3600_000;

	/** Die Menge, die ein frisch verknüpftes Device vorzieht - wie in #persistLink. */
	function startState(): SyncState {
		return { seq: 0, priority: { seq: 0, months: [monthKey(Date.now()), prevMonthKey()] } };
	}

	/** Zwei Stunden, die sicher im laufenden Monat liegen. */
	const currentMonthEntry = (id: string) =>
		entry(id, { startTs: Date.now() - 2 * 3600_000, endTs: Date.now() - 3600_000 });

	/** Ein Konto mit Historie, Aktivitäten und Einstellungen auf dem Server. */
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
		const laptop = await laptopAtStart();
		server.queries = [];
		await on(laptop, (engine) => engine.sync());

		const firstCall = server.queries.find((q) => q.startsWith("GET /api/sync?"))!;
		const params = new URLSearchParams(firstCall.split("?")[1]);
		expect(params.getAll("bucket")).toHaveLength(2);
		expect(params.get("unbucketed")).toBe("1");
		expect(params.get("since")).toBe("0");
	});

	it("bringt Aktivitaeten und Einstellungen im vorgezogenen Teil mit", async () => {
		// Ohne sie stünde die Oberfläche ohne Namen und ohne Sollstunden da.
		const laptop = await laptopAtStart();
		await on(laptop, (engine) => engine.sync());

		const activities = await on(laptop, () => store.loadActivities());
		const settings = await on(laptop, () => store.loadSettings());
		expect(activities.map((a) => a.name)).toEqual(["Entwicklung"]);
		expect(settings.hoursPerDay).toBe(7);
	});

	it("legt den vorgezogenen Teil ab, sobald die Historie durch ist", async () => {
		const laptop = await laptopAtStart();
		await on(laptop, (engine) => engine.sync());

		expect(laptop.state.priority).toBeUndefined();
		expect((await entries(laptop, OLD)).map((e) => e.id)).toEqual(["alt-1"]);
	});

	it("holt einen alten Monat auf Zuruf, ohne die Historie zu durchlaufen", async () => {
		const laptop = await laptopAtStart();
		server.queries = [];
		await on(laptop, (engine) => engine.ensureMonthSynced(OLD));

		// Genau eine Anfrage, und die nur für diesen einen Zeitraum.
		const pulls = server.queries.filter((q) => q.startsWith("GET /api/sync?"));
		expect(pulls).toHaveLength(1);
		const params = new URLSearchParams(pulls[0].split("?")[1]);
		expect(params.getAll("bucket")).toHaveLength(1);
		expect(params.get("unbucketed")).toBeNull();
		expect((await entries(laptop, OLD)).map((e) => e.id)).toEqual(["alt-1"]);
	});

	it("nimmt einen nachgeladenen Monat auf, ohne den gemeinsamen Stand vorzuziehen", async () => {
		// Der Stand darf hinterher sein - dann kommt der Monat noch einmal, was
		// nichts kostet. Vorziehen würde überspringen, was die anderen Monate
		// noch nicht kennen.
		const laptop = await laptopAtStart();
		await on(laptop, (engine) => engine.ensureMonthSynced(OLD));

		expect(laptop.state.priority?.months).toContain(OLD);
		expect(laptop.state.priority?.seq).toBe(0);
		expect(laptop.state.seq).toBe(0);
	});

	it("nach dem Backfill kostet ein Nachladen keine Anfrage mehr", async () => {
		const laptop = await laptopAtStart();
		await on(laptop, (engine) => engine.sync());
		server.queries = [];
		await on(laptop, (engine) => engine.ensureMonthSynced("2019-05"));
		expect(server.queries).toEqual([]);
	});

	it("zweimal Nachladen laedt nur einmal", async () => {
		// Der Prefetch beim Hovern feuert sonst bei jeder Mausbewegung erneut.
		const laptop = await laptopAtStart();
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
		const laptop = await laptopAtStart();

		await on(laptop, async (engine) => {
			server.hold("bucket");
			// Läuft los und bleibt am Tor stehen.
			const fetching = engine.ensureMonthSynced(OLD);
			const before = laptop.state.seq;
			await engine.sync();
			expect(engine.seq).toBe(before);

			server.release();
			await fetching;
		});

		// Und danach läuft sie wieder.
		await on(laptop, (engine) => engine.sync());
		expect(laptop.state.seq).toBeGreaterThan(0);
	});

	it("nach stop() spielt eine laufende Runde nichts mehr ein", async () => {
		// Beim Abmelden ist ein Abruf unterwegs. Seine Seite kommt an, wenn der
		// lokale Bestand gelöscht ist - ohne stop() schreibt er ihn zurück.
		const laptop = await laptopAtStart();

		await on(laptop, async (engine) => {
			server.hold("bucket");
			const fetching = engine.ensureMonthSynced(OLD);

			engine.stop();
			server.release();
			await fetching;

			expect(await store.loadEntries(OLD)).toEqual([]);
			// Und eine neue Runde fängt gar nicht erst an.
			expect(await engine.sync()).toBeNull();
		});
	});

	it("ein Device ohne vorgezogenen Teil holt weiterhin alles am Stueck", async () => {
		// Bestandsgeräte kennen schon alles; für sie darf sich nichts ändern.
		await seedServer();
		const laptop = new FakeDevice("laptop");
		server.queries = [];
		await on(laptop, (engine) => engine.sync());

		const pulls = server.queries.filter((q) => q.startsWith("GET /api/sync?"));
		expect(pulls.every((q) => !q.includes("bucket="))).toBe(true);
		expect((await entries(laptop, OLD)).map((e) => e.id)).toEqual(["alt-1"]);
	});
});
