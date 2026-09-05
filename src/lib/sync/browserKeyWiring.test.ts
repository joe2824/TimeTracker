// Der ganze Weg im Browser: verknüpfen legt einen nicht-exportierbaren
// Schlüssel in einer eigenen IndexedDB ab (keyStore.ts) und schaltet damit
// die Verschlüsselung der lokalen Ablage scharf (store.ts) - nicht nur in
// der Theorie einzelner Funktionen, sondern end-to-end über account.svelte.ts.
import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { storage, useBrowserStorage } from "../platform/fs";

useBrowserStorage();

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

const { account } = await import("./account.svelte");
const store = await import("../store");
const { bucketFor, createVaultKey, exportVaultKey, isExportable, toBase64, vaultProof } =
	await import("../crypto/vault");
const { clearLocalVaultKey, discardLegacyVaultKey, hasLegacyVaultKey, loadLocalVaultKey } =
	await import("../platform/keyStore");
const { writeLegacyVaultKey } = await import("../testing/legacyKeyStore");
const { protectSecret } = await import("../platform/secrets");

const URL = "https://zeit.example";

async function clearData(): Promise<void> {
	for (const e of await storage.readDir("data")) {
		await storage.remove(`data/${e.name}`);
	}
}

beforeEach(async () => {
	await clearData();
	await clearLocalVaultKey();
	store.setLocalEncryptionKey(null);
	globalThis.fetch = (() =>
		Promise.resolve(new Response("{}", { status: 200 }))) as typeof globalThis.fetch;
});

describe("Schlüssel-Verdrahtung im Browser", () => {
	it("legt beim Verknüpfen einen nicht-exportierbaren Schlüssel ab", async () => {
		await account.linkWithSession(URL, await createVaultKey(), "Testperson");

		const stored = await loadLocalVaultKey();
		expect(stored).not.toBeNull();
		expect(isExportable(stored!)).toBe(false);
		await expect(exportVaultKey(stored!)).rejects.toThrow();

		await account.unlink();
	});

	it("ein danach gespeicherter Eintrag liegt auf der Ablage als JWE", async () => {
		await account.linkWithSession(URL, await createVaultKey(), "Testperson");

		await store.saveEntries("2026-08", [
			{
				id: "e1",
				activityId: "a1",
				startTs: 1000,
				endTs: 2000,
				note: "Verdeckte Notiz",
				source: "manual"
			}
		]);

		const raw = await storage.readTextFile("data/entries-2026-08.json");
		expect(raw).not.toContain("Verdeckte Notiz");
		expect(raw.split(".")).toHaveLength(5);
		expect((await store.loadEntries("2026-08"))[0].note).toBe("Verdeckte Notiz");

		await account.unlink();
	});

	it("nach dem Trennen ist der Schlüssel weg, neue Dateien bleiben Klartext", async () => {
		await account.linkWithSession(URL, await createVaultKey(), "Testperson");
		await account.unlink();

		expect(await loadLocalVaultKey()).toBeNull();
		await store.saveActivities([
			{ id: "a1", name: "Nach dem Trennen", color: "#fff", sortOrder: 0, archived: false, isAbsence: false }
		]);
		const raw = await storage.readTextFile("data/activities.json");
		expect(raw).toContain("Nach dem Trennen");
	});
});

describe("Abmelden", () => {
	// Nach dem Abmelden darf im Browser nichts Lesbares zurueckbleiben - weder die
	// verschluesselten Dateien noch der Schluessel, der sie oeffnet. Der naechste
	// Mensch an diesem Rechner saehe sonst die Zeiten des vorigen.
	async function linkedWithData(): Promise<void> {
		await account.linkWithSession(URL, await createVaultKey(), "Testperson");
		await store.saveActivities([
			{ id: "a1", name: "Kundengespräch", color: "#fff", sortOrder: 0, archived: false, isAbsence: false }
		]);
		await store.saveEntries("2026-08", [
			{ id: "e1", activityId: "a1", startTs: 1000, endTs: 2000, note: "Geheim", source: "manual" }
		]);
	}

	it("nimmt den Schluessel mit", async () => {
		await linkedWithData();
		expect(await loadLocalVaultKey()).not.toBeNull();

		await account.logout();

		expect(await loadLocalVaultKey()).toBeNull();
		expect(store.getLocalEncryptionKey()).toBeNull();
	});

	it("laesst keine Datei mit Inhalt zurueck", async () => {
		await linkedWithData();

		await account.logout();

		// device.json bleibt mit Absicht: darin steht die Geraetekennung, damit ein
		// erneutes Koppeln dasselbe Geraet wiedererkennt. Sonst nichts.
		const left = (await storage.readDir("data")).map((e) => e.name);
		expect(left.filter((n) => n !== "device.json")).toEqual([]);
	});

	it("die Geraetekennung bleibt, die Kontodaten nicht", async () => {
		await linkedWithData();

		await account.logout();

		const info = await store.loadDevice();
		expect(info?.id).toBeTruthy();
		expect(info?.serverUrl).toBeUndefined();
		expect(info?.accountUserId).toBeUndefined();
		expect(info?.vaultKey).toBeUndefined();
	});
});

describe("Gerät, das vor diesem Umbau verknüpft war", () => {
	// Damals lag der Schlüssel als lesbare Bytes in device.json. Wird er nicht
	// übernommen, wirft der Start - und der Fehlerbildschirm bietet keinen Weg
	// zurück, dieser Browser hinge fest.
	it("übernimmt den alten Schlüssel aus device.json in die neue Ablage", async () => {
		const key = await createVaultKey();
		const held = await protectSecret(toBase64(new Uint8Array(await exportVaultKey(key))));
		await store.saveDevice({
			id: "altes-geraet",
			serverUrl: URL,
			vaultKey: held.data,
			protected: held.protected,
			accountUserId: "konto-a",
			accountFingerprint: "fingerabdruck-a"
		});
		expect(await loadLocalVaultKey()).toBeNull();

		await store.preloadLocalEncryptionKey();

		const migrated = store.getLocalEncryptionKey();
		expect(migrated).not.toBeNull();
		expect(isExportable(migrated!)).toBe(false);
		// Dauerhaft abgelegt, nicht nur im Speicher für diesen einen Aufruf.
		expect(await loadLocalVaultKey()).not.toBeNull();
		// Und wirklich derselbe Schlüssel, keine zufällig andere Kopie.
		expect(await vaultProof(migrated!)).toBe(await vaultProof(key));
	});
});

describe("Neuladen der Seite", () => {
	// Der Weg, der im echten Betrieb bei jedem Neuladen läuft und in keinem
	// bisherigen Test vorkam: nicht der frisch erzeugte, exportierbare Schlüssel
	// aus der Anmeldung, sondern die abgelegte Kopie, die ihre Bytes nie wieder
	// herausgibt. Der Abgleich rechnet damit Monatskennungen (bucketFor) und
	// den Kontonachweis (vaultProof) - beides ging über einen Export, der für
	// diese Kopie mit Absicht für immer fehlschlägt.
	it("die abgelegte Kopie rechnet dieselben Kennungen wie das Original", async () => {
		const original = await createVaultKey();
		await account.linkWithSession(URL, original, "Testperson");

		// Was nach einem Neuladen passiert: nichts mehr im Speicher, alles kommt
		// aus der Ablage.
		store.setLocalEncryptionKey(null);
		await store.preloadLocalEncryptionKey();

		const reloaded = store.getLocalEncryptionKey();
		expect(reloaded).not.toBeNull();
		expect(isExportable(reloaded!)).toBe(false);
		expect(await bucketFor(reloaded!, "2026-08")).toBe(await bucketFor(original, "2026-08"));
		expect(await vaultProof(reloaded!)).toBe(await vaultProof(original));

		await account.unlink();
	});

	it("liest die Einträge, die vor dem Neuladen geschrieben wurden", async () => {
		await account.linkWithSession(URL, await createVaultKey(), "Testperson");
		await store.saveEntries("2026-08", [
			{ id: "e1", activityId: "a1", startTs: 1000, endTs: 2000, note: "Vorher", source: "manual" }
		]);

		store.setLocalEncryptionKey(null);
		await store.preloadLocalEncryptionKey();

		expect((await store.loadEntries("2026-08"))[0].note).toBe("Vorher");

		await account.unlink();
	});

	it("wirft, wenn ein verknüpftes Gerät gar keinen Schlüssel hat", async () => {
		await store.saveDevice({ id: "kaputtes-geraet", serverUrl: URL });
		await expect(store.preloadLocalEncryptionKey()).rejects.toThrow();
	});

	it("nennt den Grund, wenn nur die Schlüssel-Ablage von vorher dasteht", async () => {
		// Ein Browser, der einen früheren Stand dieses Umbaus laufen hatte. Die alte
		// Ablage ist nicht zu übernehmen - dann soll wenigstens dastehen, warum, und
		// nicht "bitte neu laden", was hier nie hilft.
		await writeLegacyVaultKey();
		await store.saveDevice({ id: "alter-browser", serverUrl: URL });

		await expect(store.preloadLocalEncryptionKey()).rejects.toThrow(/anders ab/);

		await discardLegacyVaultKey();
	});

	it("räumt die alte Schlüssel-Ablage weg, sobald wieder einer dasteht", async () => {
		await writeLegacyVaultKey();
		await account.linkWithSession(URL, await createVaultKey(), "Testperson");

		store.setLocalEncryptionKey(null);
		await store.preloadLocalEncryptionKey();

		expect(await hasLegacyVaultKey()).toBe(false);
		await account.unlink();
	});

	it("ein nie verknüpftes Gerät bleibt still, kein Fehler", async () => {
		await store.saveDevice({ id: "frisches-geraet" });
		await expect(store.preloadLocalEncryptionKey()).resolves.toBeUndefined();
		expect(store.getLocalEncryptionKey()).toBeNull();
	});
});
