import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-fs", async () => (await import("../testing/fakeFs")).fakeFs);

const { files, resetFakeFs } = await import("../testing/fakeFs");
const store = await import("../store");
const {
	startTracking,
	stopTracking,
	pendingChanges,
	clearChanges,
	resetOutboxForTests,
	mergePending,
	refreshPending,
	noteChanges,
	rememberUnstamped,
	SETTINGS_ID
} = await import("./outbox");
const { defaultSettings } = await import("../types");
import type { Entry } from "../types";
import { anActivity, anEntry as e } from "../testing/fixtures";

const DEV = "geraet-1";


const onDisk = (m: string): Entry[] => JSON.parse(files.get(`data/entries-${m}.json`) ?? "[]");

beforeEach(async () => {
	resetFakeFs();
	resetOutboxForTests();
	await startTracking(DEV);
});

describe("ohne verknuepftes Konto", () => {
	it("stempelt nicht und sammelt nichts", async () => {
		stopTracking();
		resetFakeFs();
		await store.saveEntries("2026-07", [e("1")]);
		expect(onDisk("2026-07")[0].updatedAt).toBeUndefined();
		expect(onDisk("2026-07")[0].deviceId).toBeUndefined();
		expect(files.has("data/outbox.json")).toBe(false);
	});
});

describe("Eintraege", () => {
	it("stempelt einen neuen Eintrag und merkt ihn vor", async () => {
		await store.saveEntries("2026-07", [e("1")]);
		const written = onDisk("2026-07")[0];
		expect(written.deviceId).toBe(DEV);
		expect(written.updatedAt).toBeGreaterThan(0);
		expect(pendingChanges()).toEqual([
			expect.objectContaining({ kind: "entry", id: "1", month: "2026-07", deleted: false })
		]);
	});

	it("merkt eine Loeschung vor, obwohl der Datensatz weg ist", async () => {
		await store.saveEntries("2026-07", [e("1"), e("2")]);
		await clearChanges(pendingChanges());
		await store.saveEntries("2026-07", [e("2", { updatedAt: 1, deviceId: DEV })]);
		expect(pendingChanges()).toEqual([
			expect.objectContaining({ kind: "entry", id: "1", deleted: true, month: "2026-07" })
		]);
	});

	it("erfasst auch das Leeren eines ganzen Monats", async () => {
		// saveEntries löscht die Datei bei einer leeren Liste. Ohne diesen Fall
		// verschwände der Monat lokal, ohne dass der Server je davon erfährt.
		await store.saveEntries("2026-07", [e("1"), e("2")]);
		await clearChanges(pendingChanges());
		await store.saveEntries("2026-07", []);
		expect(files.has("data/entries-2026-07.json")).toBe(false);
		expect(pendingChanges().map((c) => c.id).sort()).toEqual(["1", "2"]);
		expect(pendingChanges().every((c) => c.deleted)).toBe(true);
	});

	it("fasst mehrere Aenderungen am selben Eintrag zu einer zusammen", async () => {
		await store.saveEntries("2026-07", [e("1")]);
		await store.saveEntries("2026-07", [e("1", { note: "a" })]);
		await store.saveEntries("2026-07", [e("1", { note: "b" })]);
		expect(pendingChanges()).toHaveLength(1);
	});

	it("das Anlegen und Wieder-Loeschen hinterlaesst genau die Loeschung", async () => {
		await store.saveEntries("2026-07", [e("1")]);
		await store.saveEntries("2026-07", []);
		expect(pendingChanges()).toEqual([expect.objectContaining({ id: "1", deleted: true })]);
	});

	it("stempelt bei einem Speichern ohne Aenderung nicht erneut", async () => {
		await store.saveEntries("2026-07", [e("1")]);
		const firstStamp = onDisk("2026-07")[0].updatedAt;
		await clearChanges(pendingChanges());
		await store.saveEntries("2026-07", onDisk("2026-07"));
		expect(onDisk("2026-07")[0].updatedAt).toBe(firstStamp);
		expect(pendingChanges()).toEqual([]);
	});
});

describe("Aktivitaeten und Einstellungen", () => {
	it("stempelt Aktivitaeten und merkt sie vor", async () => {
		await store.saveActivities([anActivity("a1", { name: "Projekt" })]);
		const read = await store.loadActivities();
		expect(read[0].deviceId).toBe(DEV);
		expect(pendingChanges()).toEqual([expect.objectContaining({ kind: "activity", id: "a1" })]);
	});

	it("merkt geaenderte Einstellungen als einen Datensatz vor", async () => {
		await store.saveSettings({ ...defaultSettings, hoursPerDay: 8 });
		expect(pendingChanges()).toEqual([
			expect.objectContaining({ kind: "settings", id: SETTINGS_ID })
		]);
	});

	it("gibt der Einstellungsdatei keine geliehene Id zurueck", async () => {
		// Der Vergleich braucht eine Identität, die Datei nicht – stünde sie
		// drin, täuchte sie beim nächsten Laden als unbekanntes Feld auf.
		await store.saveSettings({ ...defaultSettings, hoursPerDay: 8 });
		const raw = JSON.parse(files.get("data/settings.json")!);
		expect(raw.id).toBeUndefined();
		expect(raw.updatedAt).toBeGreaterThan(0);
	});

	it("stempelt und merkt eine vom Team vorgegebene Aktivität NICHT vor", async () => {
		// Sonst liefe sie als "eigene Änderung" hoch und käme auf JEDEM anderen
		// Gerät dieses Kontos an - auch auf einem ganz ohne Team-Mitgliedschaft.
		await store.saveActivities([
			anActivity("p1", { name: "Eigene" }),
			anActivity("team:x", { name: "Vertrieb", teamOwned: true })
		]);

		expect(pendingChanges()).toEqual([expect.objectContaining({ kind: "activity", id: "p1" })]);

		// Trotzdem ganz normal auf der Platte - nur eben unangetastet, kein Stempel.
		const read = await store.loadActivities();
		const team = read.find((a) => a.id === "team:x");
		expect(team).toBeDefined();
		expect(team?.deviceId).toBeUndefined();
		expect(team?.updatedAt).toBeUndefined();
	});

	it("rememberUnstamped merkt eine ungestempelte Team-Aktivität ebenfalls nicht vor", async () => {
		// team:x hat nie ein rev (siehe hook.activities) - ohne den Ausschluss
		// versuchte jeder Nachlauf erneut, sie als eigene hochzuladen.
		stopTracking();
		resetFakeFs();
		await store.saveActivities([anActivity("team:x", { name: "Vertrieb", teamOwned: true })]);
		await startTracking(DEV);

		await rememberUnstamped();

		expect(pendingChanges()).toEqual([]);
	});
});

describe("Outbox-Verwaltung", () => {
	it("ueberdauert einen Neustart", async () => {
		await store.saveEntries("2026-07", [e("1")]);
		resetOutboxForTests();
		await startTracking(DEV);
		expect(pendingChanges()).toEqual([expect.objectContaining({ id: "1" })]);
	});

	it("haelt eine waehrend des Hochladens dazugekommene Aenderung fest", async () => {
		// Abgehakt wird über Schlüssel, nicht über Indizes: sonst risse das
		// Abhaken eine Änderung mit weg, die es beim Hochladen noch nicht gab.
		await store.saveEntries("2026-07", [e("1")]);
		const inFlight = pendingChanges();
		await store.saveEntries("2026-07", [e("1", { updatedAt: 1, deviceId: DEV }), e("2")]);
		await clearChanges(inFlight);
		expect(pendingChanges().map((c) => c.id)).toEqual(["2"]);
	});

	it("mergePending laesst die juengste Aenderung gewinnen", () => {
		const old = [{ kind: "entry" as const, id: "1", deleted: false, at: 1 }];
		const fresh = [{ kind: "entry" as const, id: "1", deleted: true, at: 2 }];
		expect(mergePending(old, fresh)).toEqual(fresh);
	});
});

describe("Schreiben des Abgleichs neben eigenen Änderungen", () => {
	it("merkt eine eigene Speicherung vor, während der Abgleich Fremdes schreibt", async () => {
		// Früher schaltete der Abgleich den Haken für ALLE Schreibvorgänge ab,
		// solange er einspielte: ein Timer-Stopp in dieser Zeit erreichte den
		// Server nie, und die anderen Geräte sahen den Timer weiterlaufen.
		const { blockWrites } = await import("../testing/fakeFs");
		const release = blockWrites();
		const remote = store.remoteStore.saveEntries("2026-06", [e("fremd", { rev: 3, updatedAt: 1, deviceId: "x" })]);
		const local = store.saveEntries("2026-07", [e("eigen")]);
		await vi.waitFor(() => expect(pendingChanges().map((c) => c.id)).toContain("eigen"));
		release();
		await Promise.all([remote, local]);

		expect(pendingChanges().map((c) => c.id)).toEqual(["eigen"]);
		expect(onDisk("2026-06")[0].deviceId).toBe("x");
	});
});

describe("Zwei Fenster, eine outbox.json", () => {
	// Haupt- und Tray-Fenster haben je eigenen Modulzustand, schreiben aber
	// dieselbe Datei. Was das andere vorgemerkt hat, darf nicht verschwinden.
	const OUTBOX = "data/outbox.json";
	const fromOtherWindow = { kind: "entry" as const, id: "tray", month: "2026-07", deleted: false, at: 1 };
	const onDiskOutbox = () => (JSON.parse(files.get(OUTBOX) ?? "[]") as { id: string }[]).map((c) => c.id);

	it("überschreibt beim Vormerken nicht, was das andere Fenster vorgemerkt hat", async () => {
		files.set(OUTBOX, JSON.stringify([fromOtherWindow]));
		await store.saveEntries("2026-07", [e("main")]);
		expect(onDiskOutbox().sort()).toEqual(["main", "tray"]);
	});

	it("überschreibt beim Abhaken nicht, was das andere Fenster vorgemerkt hat", async () => {
		await store.saveEntries("2026-07", [e("main")]);
		const pushed = pendingChanges();
		files.set(OUTBOX, JSON.stringify([...JSON.parse(files.get(OUTBOX)!), fromOtherWindow]));
		await clearChanges(pushed);
		expect(onDiskOutbox()).toEqual(["tray"]);
	});

	it("lädt vor dem Hochladen nach, was das andere Fenster vorgemerkt hat", async () => {
		files.set(OUTBOX, JSON.stringify([fromOtherWindow]));
		await refreshPending();
		expect(pendingChanges().map((c) => c.id)).toEqual(["tray"]);
	});

	it("hakt eine neuere Änderung am selben Datensatz nicht mit ab", async () => {
		// Kam sie während des Hochladens dazu, ist sie womöglich nicht mit oben.
		vi.useFakeTimers({ now: 1_000 });
		try {
			await store.saveEntries("2026-07", [e("1")]);
			const pushed = pendingChanges();
			vi.setSystemTime(2_000);
			await store.saveEntries("2026-07", [e("1", { note: "neu" })]);
			await clearChanges(pushed);
			expect(pendingChanges().map((c) => [c.id, c.at])).toEqual([["1", 2_000]]);
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("outbox.json vorübergehend nicht lesbar", () => {
	it("verliert beim Vormerken nicht, was schon vorgemerkt war", async () => {
		// Etwa ein Freigabekonflikt unter Windows. Eine leere Liste daraus zu
		// machen und zurückzuschreiben, hiesse: alles andere Vorgemerkte ist weg.
		const { fsFaults } = await import("../testing/fakeFs");
		await store.saveEntries("2026-07", [e("a")]);
		fsFaults.readThrows = true;
		try {
			await noteChanges([{ kind: "entry", id: "b", month: "2026-07", deleted: false, at: Date.now() }]);
		} finally {
			fsFaults.readThrows = false;
		}
		await refreshPending();
		expect(pendingChanges().map((c) => c.id).sort()).toEqual(["a", "b"]);
	});
});
