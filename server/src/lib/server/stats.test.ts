import { beforeEach, describe, expect, it } from "vitest";
import { openDb, type Db } from "./db";
import {
	MAX_DEVICE_ID_LEN,
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

	// Gekuerzt statt abgewiesen fielen zwei Geraete mit gleichem Anfang ueber den
	// Eindeutigkeits-Index zu einer Zeile zusammen - eines waere aus der Zaehlung
	// verschwunden, und beide bekaemen ein "ok" zurueck.
	it("weist zu lange Gerätekennungen ab, statt sie zu kürzen", () => {
		const prefix = "x".repeat(MAX_DEVICE_ID_LEN);
		expect(
			recordTelemetryPing(db, { deviceId: prefix + "-eins", version: "0.9.1", platform: "macos" })
				.ok
		).toBe(false);
		expect(db.select().from(telemetryPings).all().length).toBe(0);
	});

	it("übernimmt nur plausible Versionen und bekannte Plattformen", () => {
		recordTelemetryPing(db, {
			deviceId: "dev-muell",
			version: "<script>alert(1)</script>",
			platform: "Marsianisch",
			date: "2026-09-01"
		});
		recordTelemetryPing(db, {
			deviceId: "dev-echt",
			version: "0.9.3-beta.2",
			platform: "WEB-Linux",
			date: "2026-09-01"
		});

		const all = db.select().from(telemetryPings).all();
		const junk = all.find((r) => r.deviceId === "dev-muell");
		expect(junk?.version).toBe("unbekannt");
		expect(junk?.platform).toBe("unbekannt");

		const real = all.find((r) => r.deviceId === "dev-echt");
		expect(real?.version).toBe("0.9.3-beta.2");
		expect(real?.platform).toBe("web-linux");
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

	// Vorher zaehlte MAU nur, was im abgefragten Verlauf lag: unter "30 Tage"
	// stand dann die Zahl eines 14-Tage-Fensters.
	it("rechnet WAU und MAU aus ihrem eigenen Fenster, nicht aus `days`", () => {
		const fixedNow = new Date("2026-09-01T12:00:00Z").getTime();
		const tag = (vorTagen: number) => toIsoDate(fixedNow - vorTagen * 86_400_000);

		// Je Geraet ein Tag: heute, vor 3, vor 10 und vor 40 Tagen.
		for (const [id, vorTagen] of [
			["dev-heute", 0],
			["dev-drei", 3],
			["dev-zehn", 10],
			["dev-vierzig", 40]
		] as const) {
			recordTelemetryPing(db, {
				deviceId: id,
				version: "0.9.1",
				platform: "macos",
				date: tag(vorTagen),
				now: fixedNow
			});
		}

		// Verlauf ueber nur 2 Tage - WAU und MAU bleiben davon unberuehrt.
		const short = getTelemetryStats(db, 2, fixedNow);
		expect(short.history.length).toBe(1);
		expect(short.summary.totalPings).toBe(1);
		expect(short.summary.wau).toBe(2); // heute + vor 3 Tagen
		expect(short.summary.mau).toBe(3); // dazu vor 10 Tagen, nicht der vor 40

		const long = getTelemetryStats(db, 90, fixedNow);
		expect(long.summary.wau).toBe(2);
		expect(long.summary.mau).toBe(3);
		expect(long.summary.totalPings).toBe(4);
	});

	// heute/gestern lasen frueher aus dem Verlauf. Bei days=1 reicht der nur bis
	// heute, "Gestern" stand damit immer auf 0.
	it("nennt Gestern auch, wenn der Verlauf nur einen Tag umfasst", () => {
		const fixedNow = new Date("2026-09-01T12:00:00Z").getTime();
		recordTelemetryPing(db, {
			deviceId: "dev-heute",
			version: "0.9.1",
			platform: "macos",
			date: "2026-09-01"
		});
		recordTelemetryPing(db, {
			deviceId: "dev-gestern",
			version: "0.9.1",
			platform: "macos",
			date: "2026-08-31"
		});

		const stats = getTelemetryStats(db, 1, fixedNow);
		expect(stats.history.length).toBe(1);
		expect(stats.summary.today).toBe(1);
		expect(stats.summary.yesterday).toBe(1);
	});

	// Sieben Tage sind heute und die sechs davor - nicht acht.
	it("zählt den siebten Tag noch zur WAU, den achten nicht mehr", () => {
		const fixedNow = new Date("2026-09-01T12:00:00Z").getTime();
		const tag = (vorTagen: number) => toIsoDate(fixedNow - vorTagen * 86_400_000);

		recordTelemetryPing(db, {
			deviceId: "dev-sechs",
			version: "0.9.1",
			platform: "macos",
			date: tag(6)
		});
		recordTelemetryPing(db, {
			deviceId: "dev-sieben",
			version: "0.9.1",
			platform: "macos",
			date: tag(7)
		});

		expect(getTelemetryStats(db, 30, fixedNow).summary.wau).toBe(1);
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

