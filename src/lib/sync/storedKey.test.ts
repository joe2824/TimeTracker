// Der hinterlegte Schluessel nach einer abgelaufenen Sitzung.
//
// Abgelaufen heisst nicht abgemeldet: der Schluessel bleibt liegen, damit die
// naechste Passkey-Anmeldung die Daten wieder oeffnet, ohne dass jemand 24
// Woerter abtippt. Er darf aber NUR an dasselbe Konto zurueck.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-fs", async () => (await import("../testing/fakeFs")).fakeFs);
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

const { resetFakeFs } = await import("../testing/fakeFs");
const { account } = await import("./account.svelte");
const store = await import("../store");
const { createVaultKey, exportVaultKey, toBase64 } = await import("../crypto/vault");
const { protectSecret, unprotectSecret } = await import("../platform/secrets");

const URL = "https://zeit.example";

/** Ein Geraet, das schon einmal an einem Konto hing. */
async function linkedDevice(userId: string) {
	const key = await createVaultKey();
	const raw = toBase64(new Uint8Array(await exportVaultKey(key)));
	const held = await protectSecret(raw);
	await store.saveDevice({
		id: "geraet-1",
		serverUrl: URL,
		vaultKey: held.data,
		protected: held.protected,
		accountUserId: userId,
		accountName: "Test"
	});
	return key;
}

/** Der Abgleich, den #persistLink anstoesst, geht hier ins Leere. */
const originalFetch = globalThis.fetch;

beforeEach(async () => {
	resetFakeFs();
	globalThis.fetch = (() =>
		Promise.resolve(new Response("{}", { status: 200 }))) as typeof globalThis.fetch;
});

afterEach(() => {
	globalThis.fetch = originalFetch;
});

describe("unlockWithStoredKey", () => {
	it("nimmt den hinterlegten Schluessel, wenn dasselbe Konto sich anmeldet", async () => {
		const key = await linkedDevice("konto-a");

		expect(await account.unlockWithStoredKey(URL, "konto-a")).toBe(true);

		expect(account.linked).toBe(true);

		// Derselbe Schluessel, nicht irgendeiner: sonst gingen die Daten nicht auf.
		const info = await store.loadDevice();
		const raw = await unprotectSecret(info!.vaultKey!, info!.protected ?? false);
		expect(raw).toBe(toBase64(new Uint8Array(await exportVaultKey(key))));
		expect(info?.accountUserId).toBe("konto-a");
	});

	it("gibt ihn NICHT an ein anderes Konto", async () => {
		await linkedDevice("konto-a");

		expect(await account.unlockWithStoredKey(URL, "konto-b")).toBe(false);
	});

	it("sagt nein, wenn gar nichts hinterlegt ist", async () => {
		await store.saveDevice({ id: "geraet-1" });

		expect(await account.unlockWithStoredKey(URL, "konto-a")).toBe(false);
	});

	it("sagt nein, wenn der Schluessel ohne Kontokennung liegt", async () => {
		// Aeltere device.json kennen das Feld nicht. Ohne Kennung ist nicht zu
		// entscheiden, wem der Schluessel gehoert - dann lieber die Phrase.
		const key = await createVaultKey();
		const held = await protectSecret(toBase64(new Uint8Array(await exportVaultKey(key))));
		await store.saveDevice({
			id: "geraet-1",
			serverUrl: URL,
			vaultKey: held.data,
			protected: held.protected
		});

		expect(await account.unlockWithStoredKey(URL, "konto-a")).toBe(false);
	});
});
