// Ob der `app`-Zwischenspeicher nach einem gescheiterten Abgleich nicht hinter
// der Platte zurückbleibt. Sonst überschreibt der nächste lokale Save (z.B.
// Timer-Start) einen frisch angekommenen Eintrag mit dem alten Stand -
// diffAndStamp sieht ihn dann als "gelöscht" an und wirft ihn samt Löschung
// in die Outbox.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeSyncServer } from "../testing/fakeSyncServer";
import { freshAccountEnv, restoreFetch, settled } from "../testing/accountHarness";
import { FakeDevice, onDevice } from "../testing/syncDevice";

vi.mock("@tauri-apps/plugin-fs", async () => (await import("../testing/fakeFs")).fakeFs);
vi.mock("svelte-sonner", () => import("../testing/toastStub"));

const { createVaultKey } = await import("../crypto/vault");
const { account } = await import("./account.svelte");
const { app } = await import("../app.svelte");
const store = await import("../store");
const { monthKey } = await import("../time/time");
const { BUILTIN_OTHERS_ID, defaultSettings } = await import("../types");
const { appTimeZone, setAppTimeZone, wallToTs } = await import("../time/tz");
const { resetOutboxForTests } = await import("./outbox");
const { files, resetFakeFs } = await import("../testing/fakeFs");

let server: FakeSyncServer;

beforeEach(() => {
	server = freshAccountEnv();
});

afterEach(restoreFetch);

describe("Zwischenspeicher nach gescheitertem Abgleich", () => {
	// Fester Zeitpunkt, an dem Berlin noch im September und Kiritimati (+14)
	// schon im Oktober liegt: wechselte die Kontozone im Lauf auf die des Geräts,
	// fiele das hier in jeder fernen Zone auf, nicht nur zufällig am Monatsende.
	beforeEach(() => {
		vi.useFakeTimers({ toFake: ["Date"], shouldAdvanceTime: true });
		vi.setSystemTime(Date.UTC(2026, 8, 30, 12, 40));
		// app.now steht seit dem Laden des Moduls auf der echten Zeit; ohne das
		// rechnete die App den aktuellen Monat am festen Zeitpunkt vorbei.
		app.now = Date.now();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("liest nach einem gescheiterten Durchgang neu, statt einen bereits eingetroffenen Eintrag zu verlieren", async () => {
		try {
			await account.linkWithSession("http://test", await createVaultKey(), "Ich");
			await settled();

			const month = monthKey(Date.now());
			// Eine zweite Aktivität, damit der lokale Start unten wirklich
			// wechselt - dieselbe wie beim entfernten Eintrag würde #startInternal
			// als "läuft schon" ohne jede Wirkung durchgehen lassen.
			await store.saveActivities([
				...(await store.loadActivities()),
				{ id: "eigene", name: "Eigene", sortOrder: 1, archived: false, isAbsence: false }
			]);
			// So sieht es aus, wenn eine Runde einen von woanders gestarteten Timer
			// schon auf die Platte geschrieben hat, bevor sie später scheitert:
			// `remoteStore` schreibt am Schreib-Haken vorbei, genau wie beim echten
			// Einspielen von Server-Daten.
			await store.remoteStore.saveEntries(month, [
				{
					id: "von-anderswo",
					activityId: BUILTIN_OTHERS_ID,
					startTs: Date.now() - 3600_000,
					endTs: null,
					note: "",
					source: "timer",
					updatedAt: Date.now() - 3600_000,
					rev: 1,
					deviceId: "anderes-geraet"
				}
			]);

			const realFetch = globalThis.fetch;
			globalThis.fetch = async () => {
				throw new Error("Netzwerk weg");
			};
			await account.syncNow();
			globalThis.fetch = realFetch;

			// Der Zwischenspeicher hat den Eintrag jetzt - der Durchgang ist
			// gescheitert, aber das Neuladen im catch-Zweig lief trotzdem.
			expect(app.monthEntries(month).some((e) => e.id === "von-anderswo")).toBe(true);

			// Und ein lokaler Timer-Start überschreibt ihn nicht mehr als
			// "gelöscht": #openEntries() findet und schließt ihn jetzt, statt ihn
			// unbemerkt aus der stehengebliebenen Kopie zu verlieren.
			await app.startActivity("eigene");
			const stored = await store.loadEntries(month);
			const remote = stored.find((e) => e.id === "von-anderswo");
			expect(remote).toBeDefined();
			expect(remote!.endTs).not.toBeNull();
		} finally {
			restoreFetch();
			await account.unlink();
		}
	});
});

describe("Abmelden", () => {
	it("vergisst offene Mitternachts-Rückfragen und verlorene Änderungen des alten Kontos", async () => {
		await account.linkWithSession("http://test", await createVaultKey(), "Ich");
		await settled();
		account.staleTimerSplits = [
			{ endedEntry: { id: "x" }, continuationEntry: { id: "y" } } as unknown as (typeof account.staleTimerSplits)[number]
		];
		account.lostEdits = 2;

		await account.unlink();

		expect(account.staleTimerSplits).toEqual([]);
		expect(account.lostEdits).toBe(0);
	});

	it("eine Runde, die erst nach dem Abmelden fertig wird, lädt nicht mehr neu", async () => {
		try {
			await account.linkWithSession("http://test", await createVaultKey(), "Ich");
			await settled();

			let release!: () => void;
			const gate = new Promise<void>((r) => (release = r));
			const realFetch = globalThis.fetch;
			globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
				await gate;
				return realFetch(...args);
			}) as typeof fetch;
			const reload = vi.spyOn(app, "reload");

			// Etwas zum Hochladen - nur eine Runde mit pushed/pulled > 0 lädt neu.
			await app.addActivity("Neu vor dem Abmelden");
			const running = account.syncNow();
			try {
				await account.unlink();
				release();
				await running.catch(() => {});

				expect(reload).not.toHaveBeenCalled();
			} finally {
				reload.mockRestore();
			}
		} finally {
			restoreFetch();
		}
	});

	it("eine Runde, die nach dem Abmelden scheitert, setzt das Konto nicht auf Fehler", async () => {
		try {
			await account.linkWithSession("http://test", await createVaultKey(), "Ich");
			await settled();

			let release!: () => void;
			const gate = new Promise<void>((r) => (release = r));
			globalThis.fetch = (async () => {
				await gate;
				throw new Error("Netzwerk weg");
			}) as typeof fetch;

			await app.addActivity("Neu vor dem Abmelden");
			const running = account.syncNow();
			await account.unlink();
			release();
			await running.catch(() => {});

			expect(account.state).toBe("off");
			expect(account.phase).toBe("idle");
		} finally {
			restoreFetch();
		}
	});
});

describe("Tray-Fenster: nur vormerken, nicht abgleichen", () => {
	const outboxIds = () =>
		(JSON.parse(files.get("data/outbox.json") ?? "[]") as { id: string }[]).map((c) => c.id);

	it("merkt Änderungen vor, ohne selbst den Server zu fragen", async () => {
		await account.linkWithSession("http://test", await createVaultKey(), "Ich");
		await settled();
		// Ein frisches Fenster: kein Haken, kein Vorgemerktes im Speicher.
		resetOutboxForTests();

		const realFetch = globalThis.fetch;
		let calls = 0;
		globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
			calls++;
			return realFetch(...args);
		}) as typeof fetch;
		try {
			await account.initWriter();
			await store.saveEntries("2026-07", [
				{ id: "im-tray", activityId: BUILTIN_OTHERS_ID, startTs: 1, endTs: 2, note: "", source: "timer" }
			]);
		} finally {
			globalThis.fetch = realFetch;
		}

		expect(calls).toBe(0);
		expect(outboxIds()).toContain("im-tray");
	});

	it("schaltet den Haken wieder ab, wenn das Hauptfenster das Konto getrennt hat", async () => {
		await account.linkWithSession("http://test", await createVaultKey(), "Ich");
		await settled();
		resetOutboxForTests();
		await account.initWriter();
		// Das Hauptfenster trennt; übrig bleibt eine Verknüpfung ohne Adresse.
		files.delete("data/device.json");
		files.delete("data/outbox.json");

		await account.initWriter();
		await store.saveEntries("2026-07", [
			{ id: "danach", activityId: BUILTIN_OTHERS_ID, startTs: 1, endTs: 2, note: "", source: "timer" }
		]);

		expect(files.has("data/outbox.json")).toBe(false);
	});

	it("lässt den Haken an, wenn die Verknüpfung nur gerade nicht lesbar ist", async () => {
		const { fsFaults } = await import("../testing/fakeFs");
		await account.linkWithSession("http://test", await createVaultKey(), "Ich");
		await settled();
		resetOutboxForTests();
		await account.initWriter();

		fsFaults.readThrows = true;
		try {
			await account.initWriter();
		} finally {
			fsFaults.readThrows = false;
		}
		await store.saveEntries("2026-07", [
			{ id: "trotzdem", activityId: BUILTIN_OTHERS_ID, startTs: 1, endTs: 2, note: "", source: "timer" }
		]);

		expect(outboxIds()).toContain("trotzdem");
	});

	it("schaltet ohne verknüpftes Konto nichts ein", async () => {
		resetOutboxForTests();
		await account.initWriter();
		await store.saveEntries("2026-07", [
			{ id: "lokal", activityId: BUILTIN_OTHERS_ID, startTs: 1, endTs: 2, note: "", source: "timer" }
		]);
		expect(files.has("data/outbox.json")).toBe(false);
	});
});

describe("Serveradresse", () => {
	it("legt die Adresse bereinigt ab, nicht so, wie sie eingegeben wurde", async () => {
		try {
			await account.linkWithSession("HTTP://Test.Example/", await createVaultKey(), "Ich");
			await settled();

			expect(account.serverUrl).toBe("http://test.example");
			expect((await store.loadDevice())?.serverUrl).toBe("http://test.example");
		} finally {
			await account.unlink();
		}
	});

	it("bereinigt beim Start eine Adresse, die eine ältere Fassung roh abgelegt hat", async () => {
		try {
			await account.linkWithSession("http://test", await createVaultKey(), "Ich");
			await settled();
			const info = (await store.loadDevice())!;
			await store.saveDevice({ ...info, serverUrl: "HTTP://Test.Example//" });

			await account.init();

			expect(account.serverUrl).toBe("http://test.example");
			expect((await store.loadDevice())?.serverUrl).toBe("http://test.example");
		} finally {
			await account.unlink();
		}
	});
});

describe("Zonenwechsel im selben Abruf wie die Einträge", () => {
	/** +14 h: dort ist der späte Abend des 31. Juli schon der 1. August. */
	const FAR = "Pacific/Kiritimati";
	let home: string;

	beforeEach(() => {
		home = appTimeZone();
		vi.useFakeTimers({ toFake: ["Date"], shouldAdvanceTime: true });
		vi.setSystemTime(Date.UTC(2026, 7, 1, 12));
	});
	afterEach(() => {
		vi.useRealTimers();
		setAppTimeZone(home);
	});

	it("legt die Einträge in die Monate der Kontozone, die mit ihnen ankommt", async () => {
		const key = await createVaultKey();
		const boundary = wallToTs(2026, 7, 31, 23, 30, 0, home);
		// Das andere Gerät arbeitet schon in der Kontozone.
		setAppTimeZone(FAR);
		await onDevice({ server, key }, new FakeDevice("anderes-geraet"), async (engine) => {
			await store.saveSettings({ ...defaultSettings, timeZone: FAR });
			await store.saveEntries("2026-08", [
				{
					id: "grenze",
					activityId: BUILTIN_OTHERS_ID,
					startTs: boundary,
					endTs: boundary + 1800_000,
					note: "",
					source: "manual"
				}
			]);
			await engine.sync();
		});
		// Dieses Gerät kennt die Kontozone noch nicht und rechnet in seiner eigenen.
		setAppTimeZone(home);
		resetFakeFs();
		resetOutboxForTests();

		try {
			await account.linkWithSession("http://test", key, "Ich");
			await settled();

			expect(appTimeZone()).toBe(FAR);
			expect((await store.loadEntries("2026-08")).map((e) => e.id)).toEqual(["grenze"]);
			expect(await store.loadEntries("2026-07")).toEqual([]);
			expect(app.monthEntries("2026-08").map((e) => e.id)).toEqual(["grenze"]);
		} finally {
			await account.unlink();
		}
	});
});
