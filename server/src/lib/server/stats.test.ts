import { beforeEach, describe, expect, it } from "vitest";
import { openDb, type Db } from "./db";
import {
	cleanupOldTelemetry,
	getTelemetryStats,
	recordTelemetryPing,
	toIsoDate
} from "./stats";
import { telemetryPings } from "./db/schema";

let db: Db;
let raw: any;

beforeEach(() => {
	const opened = openDb(":memory:");
	db = opened.db;
	raw = opened.raw;
});

describe("recordTelemetryPing", () => {
	it("speichert einen neuen Telemetrie-Ping", () => {
		const res = recordTelemetryPing(db, {
			deviceId: "device-1234",
			version: "0.9.1",
			platform: "macos"
		});
		expect(res.ok).toBe(true);

		const all = db.select().from(telemetryPings).all();
		expect(all.length).toBe(1);
		expect(all[0].deviceId).toBe("device-1234");
		expect(all[0].version).toBe("0.9.1");
		expect(all[0].platform).toBe("macos");
	});

	it("aktualisiert am selben Tag denselben Ping (Upsert) ohne Duplikat", () => {
		const now = Date.now();
		recordTelemetryPing(db, {
			deviceId: "device-1234",
			version: "0.9.0",
			platform: "windows",
			date: "2026-09-01",
			now
		});

		recordTelemetryPing(db, {
			deviceId: "device-1234",
			version: "0.9.1",
			platform: "windows",
			date: "2026-09-01",
			now: now + 5000
		});

		const all = db.select().from(telemetryPings).all();
		expect(all.length).toBe(1);
		expect(all[0].version).toBe("0.9.1");
		expect(all[0].lastSeenAt).toBe(now + 5000);
	});

	it("legt an unterschiedlichen Tagen separate Datensätze an", () => {
		recordTelemetryPing(db, {
			deviceId: "device-1234",
			version: "0.9.1",
			platform: "linux",
			date: "2026-08-31"
		});

		recordTelemetryPing(db, {
			deviceId: "device-1234",
			version: "0.9.1",
			platform: "linux",
			date: "2026-09-01"
		});

		const all = db.select().from(telemetryPings).all();
		expect(all.length).toBe(2);
	});

	it("weist ungültige oder leere Gerätekennungen ab", () => {
		expect(recordTelemetryPing(db, { deviceId: "", version: "0.9.1", platform: "macos" }).ok).toBe(
			false
		);
		expect(
			recordTelemetryPing(db, { deviceId: "  ", version: "0.9.1", platform: "macos" }).ok
		).toBe(false);
	});
});

describe("getTelemetryStats", () => {
	it("aggregiert DAU, Versionen und Plattformen korrekt", () => {
		const fixedNow = new Date("2026-09-01T12:00:00Z").getTime();

		// Heute: 2 Geräte
		recordTelemetryPing(db, {
			deviceId: "dev-mac",
			version: "0.9.1",
			platform: "macos",
			date: "2026-09-01",
			now: fixedNow
		});
		recordTelemetryPing(db, {
			deviceId: "dev-win",
			version: "0.9.1",
			platform: "windows",
			date: "2026-09-01",
			now: fixedNow
		});

		// Gestern: 2 Geräte (eines davon dasselbe wie heute)
		recordTelemetryPing(db, {
			deviceId: "dev-mac",
			version: "0.9.0",
			platform: "macos",
			date: "2026-08-31",
			now: fixedNow - 86_400_000
		});
		recordTelemetryPing(db, {
			deviceId: "dev-linux",
			version: "0.9.0",
			platform: "linux",
			date: "2026-08-31",
			now: fixedNow - 86_400_000
		});

		const stats = getTelemetryStats(db, 30, fixedNow);

		expect(stats.summary.today).toBe(2);
		expect(stats.summary.yesterday).toBe(2);
		expect(stats.summary.wau).toBe(3); // dev-mac, dev-win, dev-linux
		expect(stats.summary.mau).toBe(3);
		expect(stats.summary.totalPings).toBe(4);

		expect(stats.history.length).toBe(2);
		expect(stats.history[0].date).toBe("2026-09-01");
		expect(stats.history[0].dau).toBe(2);
		expect(stats.history[0].versions).toEqual({ "0.9.1": 2 });
		expect(stats.history[0].platforms).toEqual({ macos: 1, windows: 1 });

		expect(stats.history[1].date).toBe("2026-08-31");
		expect(stats.history[1].dau).toBe(2);
		expect(stats.history[1].versions).toEqual({ "0.9.0": 2 });
		expect(stats.history[1].platforms).toEqual({ macos: 1, linux: 1 });
	});
});

describe("cleanupOldTelemetry", () => {
	it("löscht Einträge, die älter als retentionDays sind", () => {
		const fixedNow = new Date("2026-09-01T12:00:00Z").getTime();

		// Vor 10 Tagen (bleibt)
		recordTelemetryPing(db, {
			deviceId: "dev-1",
			version: "0.9.1",
			platform: "macos",
			date: "2026-08-22",
			now: fixedNow - 10 * 86_400_000
		});

		// Vor 100 Tagen (wird gelöscht bei 90 Tagen Retention)
		recordTelemetryPing(db, {
			deviceId: "dev-alt",
			version: "0.8.0",
			platform: "macos",
			date: "2026-05-24",
			now: fixedNow - 100 * 86_400_000
		});

		const deleted = cleanupOldTelemetry(raw, 90, fixedNow);
		expect(deleted).toBe(1);

		const remaining = db.select().from(telemetryPings).all();
		expect(remaining.length).toBe(1);
		expect(remaining[0].deviceId).toBe("dev-1");
	});
});

