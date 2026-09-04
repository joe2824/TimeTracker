// Der abgelegte Schluessel darf nie wieder Bytes herausgeben - aber alles
// koennen, was der laufende Betrieb braucht: ver-/entschluesseln UND die
// abgeleiteten Kennungen rechnen (bucketFor, vaultProof).
import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import { clearLocalVaultKey, loadLocalVaultKey, saveLocalVaultKey } from "./keyStore";
import {
	bucketFor,
	createVaultKey,
	exportVaultKey,
	importVaultKey,
	isExportable,
	openRecord,
	sealRecord,
	vaultProof,
	type VaultKey
} from "../crypto/vault";

const BINDING = { kind: "local", id: "probe", rev: 0 };

/** Genau die Kopie, die `#persistLink` im Browser ablegt. */
async function storedCopy(of?: VaultKey): Promise<VaultKey> {
	const source = of ?? (await createVaultKey());
	return importVaultKey(await exportVaultKey(source), false);
}

beforeEach(clearLocalVaultKey);

describe("keyStore", () => {
	it("sagt nein, wenn nichts abgelegt ist", async () => {
		expect(await loadLocalVaultKey()).toBeNull();
	});

	it("gibt den abgelegten Schluessel zurueck", async () => {
		await saveLocalVaultKey(await storedCopy());
		expect(await loadLocalVaultKey()).not.toBeNull();
	});

	it("der zurueckgegebene Schluessel gibt nie wieder Bytes heraus", async () => {
		await saveLocalVaultKey(await storedCopy());
		const back = await loadLocalVaultKey();
		expect(isExportable(back!)).toBe(false);
		await expect(exportVaultKey(back!)).rejects.toThrow();
	});

	it("der zurueckgegebene Schluessel kann trotzdem ver- und entschluesseln", async () => {
		await saveLocalVaultKey(await storedCopy());
		const back = await loadLocalVaultKey();
		const sealed = await sealRecord(back!, { note: "hallo" }, BINDING);
		expect(await openRecord(back!, sealed, BINDING)).toEqual({ note: "hallo" });
	});

	it("rechnet dieselben Kennungen wie das exportierbare Original", async () => {
		// Der Punkt, an dem der Abgleich haengt: bucketFor und vaultProof laufen
		// beim Wiedereinstieg auf dieser Kopie. Kaemen dort andere Werte heraus -
		// oder wuerde geworfen -, faende das Geraet seine eigenen Monate nicht mehr.
		const original = await createVaultKey();
		await saveLocalVaultKey(await storedCopy(original));
		const back = await loadLocalVaultKey();
		expect(await bucketFor(back!, "2026-07")).toBe(await bucketFor(original, "2026-07"));
		expect(await vaultProof(back!)).toBe(await vaultProof(original));
	});

	it("oeffnet, was das exportierbare Original versiegelt hat", async () => {
		const original = await createVaultKey();
		await saveLocalVaultKey(await storedCopy(original));
		const sealed = await sealRecord(original, { x: 1 }, BINDING);
		expect(await openRecord((await loadLocalVaultKey())!, sealed, BINDING)).toEqual({ x: 1 });
	});

	it("ueberschreibt den vorigen Schluessel beim erneuten Ablegen", async () => {
		const a = await createVaultKey();
		await saveLocalVaultKey(await storedCopy(a));
		await saveLocalVaultKey(await storedCopy());
		const sealed = await sealRecord(a, { x: 1 }, BINDING);
		await expect(openRecord((await loadLocalVaultKey())!, sealed, BINDING)).rejects.toThrow();
	});

	it("loescht den Schluessel", async () => {
		await saveLocalVaultKey(await storedCopy());
		await clearLocalVaultKey();
		expect(await loadLocalVaultKey()).toBeNull();
	});
});
