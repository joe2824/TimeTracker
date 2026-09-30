// Im Browser liegt der Bestand verschlüsselt; eine Sicherung daneben darf ihn
// nicht als Klartext wiederholen.
import "fake-indexeddb/auto";
import { describe, expect, it, vi } from "vitest";
import { storage, useBrowserStorage } from "../platform/fs";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

useBrowserStorage();

const { snapshotBeforePairing, SNAPSHOT_DIR } = await import("./backup");
const { saveActivities, setLocalEncryptionKey } = await import("../store");
const { createVaultKey } = await import("../crypto/vault");

describe("Sicherung vor der Kopplung im Browser", () => {
	it("legt keine lesbare Kopie neben den verschlüsselten Bestand", async () => {
		setLocalEncryptionKey(await createVaultKey());
		await saveActivities([
			{ id: "a1", name: "Kundengespräch", color: "blue", archived: false, isAbsence: false, sortOrder: 0 }
		]);

		expect(await snapshotBeforePairing()).toBeNull();
		const left = await storage.readDir(SNAPSHOT_DIR).catch(() => []);
		expect(left).toEqual([]);
	});
});
