import { describe, it, expect, beforeEach, vi } from "vitest";
import { resetFakeFs } from "./testing/fakeFs";
import {
	BUILTIN_ABSENCE_ID,
	BUILTIN_OTHERS_ID,
	defaultSettings,
	type Activity,
	type Entry
} from "./types";
import type { TimeTrackerBackup } from "./backup";

vi.mock("@tauri-apps/plugin-fs", async () => (await import("./testing/fakeFs")).fakeFs);
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const { createBackupData, inspectBackup, restoreBackup } = await import("./backup");
const { saveActivities, saveEntries, saveSettings } = await import("./store");
const { app } = await import("./app.svelte");
const { account } = await import("./sync/account.svelte");

describe("Backup & Restore", () => {
	beforeEach(() => {
		resetFakeFs();
		app.clearLocalData();
		account.backfilling = false;
		account.historyIncomplete = false;
	});

	const sampleActivities: Activity[] = [
		{ id: "act-1", name: "Entwicklung", color: "blue", archived: false, isAbsence: false, sortOrder: 0 },
		{ id: "act-2", name: "Meeting", color: "amber", archived: false, isAbsence: false, sortOrder: 1 }
	];

	const sampleEntries202607: Entry[] = [
		{
			id: "e-1",
			activityId: "act-1",
			startTs: Date.UTC(2026, 6, 1, 8, 0),
			endTs: Date.UTC(2026, 6, 1, 12, 0),
			note: "Projekt X",
			source: "manual"
		}
	];

	const sampleEntries202608: Entry[] = [
		{
			id: "e-2",
			activityId: "act-2",
			startTs: Date.UTC(2026, 7, 1, 9, 0),
			endTs: Date.UTC(2026, 7, 1, 10, 0),
			note: "Sprint Review",
			source: "manual"
		}
	];

	it("erstellt eine vollständige Sicherung aller Daten", async () => {
		await saveActivities(sampleActivities);
		await saveSettings({ ...defaultSettings, senderName: "Max Mustermann" });
		await saveEntries("2026-07", sampleEntries202607);
		await saveEntries("2026-08", sampleEntries202608);

		const backup = await createBackupData();

		expect(backup.format).toBe("timetracker-backup");
		expect(backup.version).toBe(1);
		expect(backup.settings.senderName).toBe("Max Mustermann");
		expect(backup.activities).toHaveLength(2);
		expect(Object.keys(backup.entries)).toEqual(["2026-08", "2026-07"]);
		expect(backup.entries["2026-07"]).toHaveLength(1);
		expect(backup.entries["2026-08"]).toHaveLength(1);
	});

	it("hält fest, dass die Sicherung den ganzen Bestand enthält", async () => {
		await saveEntries("2026-07", sampleEntries202607);

		expect((await createBackupData()).complete).toBe(true);
	});

	it("sichert nicht, solange ältere Monate fehlen", async () => {
		await saveEntries("2026-07", sampleEntries202607);
		account.backfilling = true;
		account.historyIncomplete = true;

		await expect(createBackupData()).rejects.toThrow(/unvollständig/);
	});

	it("sichert, wenn der Abgleich nur wiederholt, was schon dasteht", async () => {
		// Ein Geraet, das der Nachlauf zurueckgesetzt hat, holt die Monate ein
		// zweites Mal - sie liegen aber laengst hier. Zu sperren waere Fehlalarm.
		await saveEntries("2026-07", sampleEntries202607);
		account.backfilling = true;
		account.historyIncomplete = false;

		expect((await createBackupData()).complete).toBe(true);
	});

	it("spielt nicht ein, solange ältere Monate nachkommen", async () => {
		const backup: TimeTrackerBackup = {
			version: 1,
			format: "timetracker-backup",
			createdAt: "2026-08-30T12:00:00.000Z",
			settings: defaultSettings,
			activities: sampleActivities,
			entries: { "2026-07": sampleEntries202607 }
		};
		account.backfilling = true;
		account.historyIncomplete = true;

		await expect(restoreBackup(backup, "merge")).rejects.toThrow(/nachgeladen|geladen/);
		expect(app.monthEntries("2026-07")).toHaveLength(0);
	});

	it("meldet eine Sicherung ohne Vollständigkeits-Vermerk als ungeprüft", () => {
		const legacy: TimeTrackerBackup = {
			version: 1,
			format: "timetracker-backup",
			createdAt: "2026-08-30T12:00:00.000Z",
			settings: defaultSettings,
			activities: sampleActivities,
			entries: { "2026-07": sampleEntries202607 }
		};

		expect(inspectBackup(JSON.stringify(legacy)).stats?.complete).toBe(false);
		expect(inspectBackup(JSON.stringify({ ...legacy, complete: true })).stats?.complete).toBe(true);
	});

	it("prüft und analysiert eine Sicherungsdatei korrekt", () => {
		const validBackup: TimeTrackerBackup = {
			version: 1,
			format: "timetracker-backup",
			createdAt: "2026-08-30T12:00:00.000Z",
			settings: defaultSettings,
			activities: sampleActivities,
			entries: {
				"2026-07": sampleEntries202607,
				"2026-08": sampleEntries202608
			}
		};

		const res = inspectBackup(JSON.stringify(validBackup));
		expect(res.valid).toBe(true);
		expect(res.stats).toBeDefined();
		expect(res.stats?.activityCount).toBe(2);
		expect(res.stats?.monthCount).toBe(2);
		expect(res.stats?.entryCount).toBe(2);
		expect(res.stats?.months).toEqual(["2026-07", "2026-08"]);
	});

	it("weist ungültige Sicherungsdateien mit Fehlermeldung ab", () => {
		expect(inspectBackup("kein-json").valid).toBe(false);
		expect(inspectBackup(JSON.stringify({ format: "wrong" })).valid).toBe(false);
		expect(inspectBackup(JSON.stringify({ activities: "not-an-array" })).valid).toBe(false);
	});

	it("stellt Daten im Ersetzen-Modus (replace) vollständig wieder her", async () => {
		// Vorhandener alter Stand
		await saveActivities([{ id: "old-act", name: "Alt", color: "red", archived: false, isAbsence: false, sortOrder: 0 }]);
		await saveEntries("2026-06", [
			{ id: "e-old", activityId: "old-act", startTs: Date.UTC(2026, 5, 1, 8), endTs: Date.UTC(2026, 5, 1, 9), note: "", source: "manual" }
		]);

		const backup: TimeTrackerBackup = {
			version: 1,
			format: "timetracker-backup",
			createdAt: "2026-08-30T12:00:00.000Z",
			settings: { ...defaultSettings, senderName: "Neuer Name" },
			activities: sampleActivities,
			entries: {
				"2026-07": sampleEntries202607
			}
		};

		const result = await restoreBackup(backup, "replace");

		expect(result.restoredActivities).toBe(2);
		expect(result.restoredMonths).toBe(1);
		expect(result.restoredEntries).toBe(1);

		expect(app.settings.senderName).toBe("Neuer Name");
		// Die Sicherung bringt zwei Aktivitaeten mit; "Others" und "Abwesenheiten"
		// stellt die App danach selbst her - ohne sie fehlt der Bericht seine
		// Sammelzeile. Frueher tauchten sie erst beim naechsten Start auf.
		expect(app.activities.map((a) => a.id)).toEqual(
			expect.arrayContaining(["act-1", "act-2", BUILTIN_OTHERS_ID, BUILTIN_ABSENCE_ID])
		);
		expect(app.activities).toHaveLength(4);
	});

	it("stellt Daten im Zusammenführen-Modus (merge) additiv wieder her", async () => {
		// Vorhandener lokaler Stand
		await saveActivities([
			{ id: "act-1", name: "Entwicklung Lokal", color: "blue", archived: false, isAbsence: false, sortOrder: 0 },
			{ id: "act-local", name: "Nur Lokal", color: "green", archived: false, isAbsence: false, sortOrder: 2 }
		]);
		await saveEntries("2026-07", [
			{ id: "e-local", activityId: "act-local", startTs: Date.UTC(2026, 6, 2, 8), endTs: Date.UTC(2026, 6, 2, 9), note: "", source: "manual" }
		]);

		const backup: TimeTrackerBackup = {
			version: 1,
			format: "timetracker-backup",
			createdAt: "2026-08-30T12:00:00.000Z",
			settings: { ...defaultSettings, senderName: "Backup Name" },
			activities: sampleActivities, // hat act-1 und act-2
			entries: {
				"2026-07": sampleEntries202607 // hat e-1
			}
		};

		const result = await restoreBackup(backup, "merge");

		expect(result.restoredActivities).toBe(3); // act-1, act-2, act-local
		// Drei aus der Zusammenfuehrung, dazu die beiden eingebauten Zeilen.
		expect(app.activities).toHaveLength(5);
		expect(app.activities.filter((a) => a.name === "Others")).toHaveLength(1);
		expect(app.activities.filter((a) => a.isAbsence)).toHaveLength(1);
		expect(app.monthEntries("2026-07")).toHaveLength(2); // e-1 und e-local
	});
});
