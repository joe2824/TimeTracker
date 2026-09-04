// Im Browser muessen Aktivitaeten, Einstellungen, Eintraege und Reports
// verschluesselt auf der Ablage liegen - device.json und outbox.json nicht.
import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import { storage, useBrowserStorage } from "./platform/fs";

useBrowserStorage();

const {
	loadActivities,
	loadDevice,
	loadEntries,
	loadSettings,
	loadTimeReport,
	saveActivities,
	saveDevice,
	saveEntries,
	saveOutbox,
	saveSettings,
	saveTimeReport,
	setLocalEncryptionKey
} = await import("./store");

async function clear(): Promise<void> {
	for (const e of await storage.readDir("data")) {
		await storage.remove(`data/${e.name}`);
	}
}

const { createVaultKey: freshKey } = await import("./crypto/vault");

beforeEach(async () => {
	await clear();
	setLocalEncryptionKey(null);
});

describe("lokale Verschlüsselung im Browser", () => {
	it("legt Aktivitäten als JWE ab, nicht als lesbares JSON", async () => {
		setLocalEncryptionKey(await freshKey());
		await saveActivities([{ id: "a1", name: "Kundengespräch", color: "#fff", sortOrder: 0, archived: false, isAbsence: false }]);
		const raw = await storage.readTextFile("data/activities.json");
		expect(raw).not.toContain("Kundengespräch");
		// JWE-Compact: fuenf durch Punkte getrennte Base64url-Abschnitte, kein JSON.
		expect(raw.split(".")).toHaveLength(5);
		expect(raw.trimStart()[0]).not.toBe("[");
	});

	it("Hin- und Rückweg liefert denselben Wert", async () => {
		setLocalEncryptionKey(await freshKey());
		const activities = [{ id: "a1", name: "Deep Work", color: "#123456", sortOrder: 0, archived: false, isAbsence: false }];
		await saveActivities(activities);
		expect(await loadActivities()).toEqual(activities);
	});

	it("verschlüsselt Einträge, Einstellungen und Zeitwirtschaftsreport gleichermaßen", async () => {
		setLocalEncryptionKey(await freshKey());
		await saveEntries("2026-08", [
			{
				id: "e1",
				activityId: "a1",
				startTs: 1000,
				endTs: 2000,
				note: "Geheimprojekt Phoenix",
				source: "manual"
			}
		]);
		await saveSettings({
			bossEmail: "chef@geheim.de",
			senderName: "Jemand",
			rounding: 0.25,
			hoursPerDay: 8,
			reportSentMonths: [],
			workDays: [1, 2, 3, 4, 5]
		} as never);
		await saveTimeReport({
			month: "2026-08",
			importedAt: Date.now(),
			updatedAt: Date.now(),
			rev: 1,
			deviceId: "d1",
			days: []
		});

		const entriesRaw = await storage.readTextFile("data/entries-2026-08.json");
		const settingsRaw = await storage.readTextFile("data/settings.json");
		const reportRaw = await storage.readTextFile("data/timereport-2026-08.json");
		expect(entriesRaw).not.toContain("Geheimprojekt");
		expect(settingsRaw).not.toContain("geheim.de");
		expect(reportRaw.split(".")).toHaveLength(5);

		expect((await loadEntries("2026-08"))[0].note).toBe("Geheimprojekt Phoenix");
		expect((await loadSettings()).bossEmail).toBe("chef@geheim.de");
		expect((await loadTimeReport("2026-08"))?.deviceId).toBe("d1");
	});

	it("ohne Schlüssel bleibt es beim Klartext (Verhalten wie bisher)", async () => {
		await saveActivities([{ id: "a1", name: "Sichtbar", color: "#fff", sortOrder: 0, archived: false, isAbsence: false }]);
		const raw = await storage.readTextFile("data/activities.json");
		expect(raw).toContain("Sichtbar");
		expect(await loadActivities()).toEqual([{ id: "a1", name: "Sichtbar", color: "#fff", sortOrder: 0, archived: false, isAbsence: false }]);
	});

	it("eine von Hand geschriebene Klartextdatei liest sich weiterhin korrekt und wird beim nächsten Speichern verschlüsselt", async () => {
		await storage.writeTextFile(
			"data/activities.json",
			JSON.stringify([{ id: "alt", name: "Aus alter Zeit", color: "#000", sortOrder: 0, archived: false, isAbsence: false }])
		);
		setLocalEncryptionKey(await freshKey());
		// Migrationspfad: trotz gesetztem Schlüssel liest sich die alte Klartextdatei.
		expect(await loadActivities()).toEqual([
			{ id: "alt", name: "Aus alter Zeit", color: "#000", sortOrder: 0, archived: false, isAbsence: false }
		]);
		// Naechstes Speichern verschluesselt sie.
		await saveActivities([{ id: "alt", name: "Aus alter Zeit", color: "#000", sortOrder: 0, archived: false, isAbsence: false }]);
		const raw = await storage.readTextFile("data/activities.json");
		expect(raw).not.toContain("Aus alter Zeit");
	});

	it("device.json und outbox.json bleiben Klartext, auch mit gesetztem Schlüssel", async () => {
		setLocalEncryptionKey(await freshKey());
		await saveDevice({ id: "geraet-1", accountName: "Sichtbarer Name" });
		await saveOutbox([{ kind: "entry", id: "e1", deleted: false, at: 1 }]);

		const deviceRaw = await storage.readTextFile("data/device.json");
		const outboxRaw = await storage.readTextFile("data/outbox.json");
		expect(deviceRaw).toContain("Sichtbarer Name");
		expect(outboxRaw).toContain("e1");
		expect(await loadDevice()).toMatchObject({ id: "geraet-1", accountName: "Sichtbarer Name" });
	});

	it("manipuliertes Chiffrat landet in Quarantäne, nicht in stiller Falschentschlüsselung", async () => {
		setLocalEncryptionKey(await freshKey());
		await saveEntries("2026-08", [
			{ id: "e1", activityId: "a1", startTs: 1000, endTs: 2000, note: "x", source: "manual" }
		]);
		const raw = await storage.readTextFile("data/entries-2026-08.json");
		const parts = raw.split(".");
		parts[3] = (parts[3][0] === "A" ? "B" : "A") + parts[3].slice(1);
		await storage.writeTextFile("data/entries-2026-08.json", parts.join("."));

		expect(await loadEntries("2026-08")).toEqual([]);
		// Die Originaldatei ist umbenannt, nicht verworfen.
		const names = (await storage.readDir("data")).map((e) => e.name);
		expect(names.some((n) => n.includes("entries-2026-08.json.beschaedigt-"))).toBe(true);
	});

	it("falscher Schlüssel öffnet nichts", async () => {
		setLocalEncryptionKey(await freshKey());
		await saveActivities([{ id: "a1", name: "x", color: "#fff", sortOrder: 0, archived: false, isAbsence: false }]);
		setLocalEncryptionKey(await freshKey());
		expect(await loadActivities()).toEqual([]);
	});
});
