// Der Bestand, der nie einen Schreib-Haken gesehen hat - findet er den Server?
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeSyncServer } from "../testing/fakeSyncServer";
import { FakeDevice, onDevice, withoutAccount } from "../testing/syncDevice";
import { anActivity, anEntry, MONTH, ts } from "../testing/fixtures";
import type { VaultKey } from "../crypto/vault";

vi.mock("@tauri-apps/plugin-fs", async () => (await import("../testing/fakeFs")).fakeFs);

const { createVaultKey } = await import("../crypto/vault");
const { rememberUnstamped } = await import("./outbox");
const { resetFakeFs } = await import("../testing/fakeFs");
const store = await import("../store");
const { defaultSettings } = await import("../types");
import type { Activity, Entry } from "../types";
import type { SyncEngine } from "./engine";



let server: FakeSyncServer;
let key: VaultKey;


const on = <T,>(g: FakeDevice, fn: (engine: SyncEngine) => Promise<T>): Promise<T> =>
	onDevice({ server, key }, g, fn);

/** Was AccountState bei jedem Start tut: holen, Ungestempeltes vormerken, hochladen. */
async function link(g: FakeDevice, opts: { nurEigenes?: boolean } = {}): Promise<void> {
	await on(g, async (engine) => {
		await engine.sync();
		// Was AccountState prueft, bevor es nachliest: gehoert der ungestempelte
		// Bestand ueberhaupt zu DIESEM Konto?
		const info = await store.loadDevice();
		const own =
			!opts.nurEigenes ||
			!info?.dataOwner ||
			!info.accountFingerprint ||
			info.dataOwner === info.accountFingerprint;
		if (own) await rememberUnstamped();
		await engine.sync();
	});
}

const activity = (id: string, name: string, color: string): Activity =>
	anActivity(id, { name, color });

const entry = (id: string, activityId: string): Entry =>
	anEntry(id, { activityId, startTs: ts(15, 9), endTs: ts(15, 12) });

beforeEach(async () => {
	resetFakeFs();
	server = new FakeSyncServer();
	key = await createVaultKey();
});

describe("Nachlese: was der Schreib-Haken nie gesehen hat", () => {
	it("laedt den GESAMTEN lokalen Bestand hoch, nicht nur das danach Geaenderte", async () => {
		const desktop = new FakeDevice("rechner");

		// Der Mensch benutzt die App eine Weile ohne Konto.
		await withoutAccount(desktop, async () => {
			await store.saveActivities([
				activity("akt-1", "Projekt A", "#ff0000"),
				activity("akt-2", "Projekt B", "#00ff00")
			]);
			await store.saveSettings({ ...defaultSettings, hoursPerDay: 7 });
			await store.saveEntries(MONTH, [entry("e1", "akt-1"), entry("e2", "akt-2")]);
		});

		// Jetzt verknuepft er ein Konto und gleicht ab.
		await link(desktop);

		expect(server.kinds()).toEqual({ entry: 2, activity: 2, settings: 1 });
	});

	it("bringt einem zweiten Geraet Aktivitaeten UND Einstellungen mit", async () => {
		const desktop = new FakeDevice("rechner");
		await withoutAccount(desktop, async () => {
			await store.saveActivities([activity("akt-1", "Projekt A", "#ff0000")]);
			await store.saveSettings({ ...defaultSettings, hoursPerDay: 7 });
			await store.saveEntries(MONTH, [entry("e1", "akt-1")]);
		});
		await link(desktop);

		const browser = new FakeDevice("browser");
		await link(browser);

		const loaded = await on(browser, () => store.loadActivities());
		expect(loaded.map((a) => a.name)).toEqual(["Projekt A"]);
		const s = await on(browser, () => store.loadSettings());
		expect(s.hoursPerDay).toBe(7);
		const e = await on(browser, () => store.loadEntries(MONTH));
		expect(e).toHaveLength(1);
	});

	it("ueberschreibt die Einstellungen des Kontos NICHT mit den Voreinstellungen des Neulings", async () => {
		const desktop = new FakeDevice("rechner");
		await withoutAccount(desktop, async () => {
			await store.saveSettings({ ...defaultSettings, hoursPerDay: 7 });
		});
		await link(desktop);

		// Ein zweites Geraet, das schon einmal lief und dabei Voreinstellungen
		// weggeschrieben hat - der haeufigste Fall im Browser.
		const browser = new FakeDevice("browser");
		await withoutAccount(browser, async () => {
			await store.saveSettings({ ...defaultSettings });
		});
		await link(browser);

		expect((await on(browser, () => store.loadSettings())).hoursPerDay).toBe(7);
		// Und der Rechner bekommt seinen eigenen Wert nicht zerschossen zurueck.
		await link(desktop);
		expect((await on(desktop, () => store.loadSettings())).hoursPerDay).toBe(7);
	});

	it("traegt den Bestand NICHT in ein fremdes Konto", async () => {
		// Abgemeldet, neues Konto angelegt: der alte Bestand darf nicht ins neue
		// Konto wandern.
		const desktop = new FakeDevice("rechner");
		await withoutAccount(desktop, async () => {
			await store.saveActivities([activity("akt-1", "Geheim", "#ff0000")]);
			await store.saveEntries(MONTH, [entry("e1", "akt-1")]);
		});
		await link(desktop);
		expect(server.kinds()).toEqual({ entry: 1, activity: 1 });

		// Jetzt haengt dasselbe Geraet an einem ANDEREN Konto - anderer Schluessel.
		const foreign = new FakeSyncServer();
		const oldServer = server;
		server = foreign;
		key = await createVaultKey();
		await on(desktop, async () => {
			// Was #persistLink beim Kontowechsel vermerkt: der Bestand gehoert noch
			// dem alten Konto.
			const info = (await store.loadDevice()) ?? { id: desktop.id };
			await store.saveDevice({ ...info, accountFingerprint: "neu", dataOwner: "alt" });
		});
		await link(desktop, { nurEigenes: true });

		expect(foreign.kinds()).toEqual({});
		expect(oldServer.kinds()).toEqual({ entry: 1, activity: 1 });
	});

	it("nimmt die Merkliste des vorigen Kontos nicht mit", async () => {
		// Der Stempel-Waechter allein reicht nicht: `#pushAll` liest die OUTBOX -
		// was dort vom vorigen Konto liegen blieb, ginge sonst hoch, ohne dass je
		// eine Nachlese lief.
		const desktop = new FakeDevice("rechner");
		await withoutAccount(desktop, async () => {
			await store.saveActivities([activity("akt-1", "Geheim", "#ff0000")]);
			await store.saveEntries(MONTH, [entry("e1", "akt-1")]);
		});

		// Vormerken, aber NICHT hochladen - so sieht es aus, wenn ein Abgleich
		// mittendrin abbricht oder der Server gerade weg ist.
		await on(desktop, async () => {
			await rememberUnstamped();
		});
		expect(await on(desktop, async () => (await store.loadOutbox()).length)).toBeGreaterThan(0);

		// Jetzt ein anderes Konto. Was AccountState beim Wechsel tut: Merkliste weg.
		await on(desktop, async () => {
			await store.clearOutbox();
		});

		const foreign = new FakeSyncServer();
		server = foreign;
		key = await createVaultKey();
		await on(desktop, async () => {
			const info = (await store.loadDevice()) ?? { id: desktop.id };
			await store.saveDevice({ ...info, accountFingerprint: "neu", dataOwner: "alt" });
		});
		await link(desktop, { nurEigenes: true });

		expect(foreign.kinds()).toEqual({});
	});

	it("laedt spaeter Angelegtes weiterhin hoch", async () => {
		const desktop = new FakeDevice("rechner");
		await link(desktop);
		await on(desktop, async (engine) => {
			await store.saveActivities([activity("akt-9", "Danach", "#0000ff")]);
			await engine.sync();
		});
		expect(server.kinds()).toEqual({ activity: 1 });
	});
});
