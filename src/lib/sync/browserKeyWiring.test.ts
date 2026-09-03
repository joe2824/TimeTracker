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
const { createVaultKey } = await import("../crypto/vault");
const { loadLocalVaultKey } = await import("../platform/keyStore");

const URL = "https://zeit.example";

async function clearData(): Promise<void> {
	for (const e of await storage.readDir("data")) {
		await storage.remove(`data/${e.name}`);
	}
}

beforeEach(async () => {
	await clearData();
	store.setLocalEncryptionKey(null);
	globalThis.fetch = (() =>
		Promise.resolve(new Response("{}", { status: 200 }))) as typeof globalThis.fetch;
});

describe("Schlüssel-Verdrahtung im Browser", () => {
	it("legt beim Verknüpfen einen nicht-exportierbaren Schlüssel ab", async () => {
		const key = await createVaultKey();
		await account.linkWithSession(URL, key, "Testperson");

		const stored = await loadLocalVaultKey();
		expect(stored).not.toBeNull();
		await expect(crypto.subtle.exportKey("raw", stored!)).rejects.toThrow();

		await account.unlink();
	});

	it("ein danach gespeicherter Eintrag liegt auf der Ablage als JWE", async () => {
		const key = await createVaultKey();
		await account.linkWithSession(URL, key, "Testperson");

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
		const key = await createVaultKey();
		await account.linkWithSession(URL, key, "Testperson");
		await account.unlink();

		expect(await loadLocalVaultKey()).toBeNull();
		await store.saveActivities([{ id: "a1", name: "Nach dem Trennen", color: "#fff", sortOrder: 0, archived: false, isAbsence: false }]);
		const raw = await storage.readTextFile("data/activities.json");
		expect(raw).toContain("Nach dem Trennen");
	});
});
