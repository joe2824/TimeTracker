// Der abgelegte Schluessel darf nie wieder Bytes herausgeben - nur noch
// ver-/entschluesseln.
import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import { clearLocalVaultKey, loadLocalVaultKey, saveLocalVaultKey } from "./keyStore";

async function freshKey(): Promise<CryptoKey> {
	return crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, [
		"encrypt",
		"decrypt"
	]);
}

async function nonExtractableCopy(key: CryptoKey): Promise<CryptoKey> {
	const raw = await crypto.subtle.exportKey("raw", key);
	return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

beforeEach(clearLocalVaultKey);

describe("keyStore", () => {
	it("sagt nein, wenn nichts abgelegt ist", async () => {
		expect(await loadLocalVaultKey()).toBeNull();
	});

	it("gibt den abgelegten Schluessel zurueck", async () => {
		const key = await nonExtractableCopy(await freshKey());
		await saveLocalVaultKey(key);
		const back = await loadLocalVaultKey();
		expect(back).not.toBeNull();
	});

	it("der zurueckgegebene Schluessel gibt nie wieder Bytes heraus", async () => {
		const key = await nonExtractableCopy(await freshKey());
		await saveLocalVaultKey(key);
		const back = await loadLocalVaultKey();
		await expect(crypto.subtle.exportKey("raw", back!)).rejects.toThrow();
	});

	it("der zurueckgegebene Schluessel kann trotzdem ver- und entschluesseln", async () => {
		const key = await nonExtractableCopy(await freshKey());
		await saveLocalVaultKey(key);
		const back = await loadLocalVaultKey();
		const iv = crypto.getRandomValues(new Uint8Array(12));
		const ct = await crypto.subtle.encrypt(
			{ name: "AES-GCM", iv },
			back!,
			new TextEncoder().encode("hallo")
		);
		const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, back!, ct);
		expect(new TextDecoder().decode(pt)).toBe("hallo");
	});

	it("ueberschreibt den vorigen Schluessel beim erneuten Ablegen", async () => {
		const a = await nonExtractableCopy(await freshKey());
		const b = await nonExtractableCopy(await freshKey());
		await saveLocalVaultKey(a);
		await saveLocalVaultKey(b);
		// Kein direkter Vergleich moeglich (nicht-exportierbar) - stattdessen:
		// ein mit `a` verschluesseltes Chiffrat oeffnet sich nicht mehr mit dem,
		// was jetzt abgelegt ist.
		const iv = crypto.getRandomValues(new Uint8Array(12));
		const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, a, new TextEncoder().encode("x"));
		const back = await loadLocalVaultKey();
		await expect(crypto.subtle.decrypt({ name: "AES-GCM", iv }, back!, ct)).rejects.toThrow();
	});

	it("loescht den Schluessel", async () => {
		await saveLocalVaultKey(await nonExtractableCopy(await freshKey()));
		await clearLocalVaultKey();
		expect(await loadLocalVaultKey()).toBeNull();
	});
});
