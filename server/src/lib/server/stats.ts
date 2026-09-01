// Anonyme Nutzungsstatistik und Telemetrie auf dem TimeTracker-Server.
// Erfasst ausschliesslich: Datum, anonyme Geraetekennung, App-Version und Betriebssystem/Plattform.
import { desc, gte, sql } from "drizzle-orm";
import type { Db, DbLike } from "./db";
import { telemetryPings } from "./db/schema";
import type Database from "better-sqlite3";

export interface TelemetryPingInput {
	deviceId: string;
	version: string;
	platform: string;
	date?: string;
	now?: number;
}

export interface DayStats {
	date: string;
	dau: number;
	versions: Record<string, number>;
	platforms: Record<string, number>;
}

export interface TelemetrySummary {
	today: number;
	yesterday: number;
	wau: number; // Letzte 7 Tage (Unique Devices)
	mau: number; // Letzte 30 Tage (Unique Devices)
	totalPings: number;
	versions: Record<string, number>;
	platforms: Record<string, number>;
}

export interface TelemetryStatsResult {
	summary: TelemetrySummary;
	history: DayStats[];
}

/** Erzeugt den Datums-String "YYYY-MM-DD" fuer einen Zeitstempel in lokaler / UTC Zeit. */
export function toIsoDate(timestamp = Date.now()): string {
	return new Date(timestamp).toISOString().slice(0, 10);
}

/** Sanitiert einen String fuer sichere Ablage und Anzeige. */
function sanitize(val: unknown, maxLen = 40): string {
	if (typeof val !== "string") return "unbekannt";
	const trimmed = val.trim().slice(0, maxLen);
	return trimmed.length > 0 ? trimmed : "unbekannt";
}

/**
 * Nimmt einen anonymen Telemetrie-Ping entgegen und aktualisiert den Tageseintrag (Upsert).
 * Pro Geraet und Tag existiert maximal eine Zeile in der Datenbank.
 */
export function recordTelemetryPing(
	db: DbLike,
	input: TelemetryPingInput
): { ok: boolean; date: string } {
	const deviceId = sanitize(input.deviceId, 64);
	if (!deviceId || deviceId === "unbekannt") {
		return { ok: false, date: "" };
	}

	const version = sanitize(input.version, 32);
	const platform = sanitize(input.platform, 32).toLowerCase();
	const now = input.now ?? Date.now();
	const date = input.date && /^\d{4}-\d{2}-\d{2}$/.test(input.date) ? input.date : toIsoDate(now);

	db.insert(telemetryPings)
		.values({
			date,
			deviceId,
			version,
			platform,
			lastSeenAt: now
		})
		.onConflictDoUpdate({
			target: [telemetryPings.date, telemetryPings.deviceId],
			set: {
				version,
				platform,
				lastSeenAt: now
			}
		})
		.run();

	return { ok: true, date };
}

/**
 * Liest die Telemetrie-Auswertung fuer die letzten `days` Tage aus.
 */
export function getTelemetryStats(db: DbLike, days = 30, now = Date.now()): TelemetryStatsResult {
	const todayDate = toIsoDate(now);
	const yesterdayDate = toIsoDate(now - 86_400_000);
	const sevenDaysAgoDate = toIsoDate(now - 7 * 86_400_000);
	const cutoffDate = toIsoDate(now - days * 86_400_000);

	const rows = db
		.select({
			date: telemetryPings.date,
			deviceId: telemetryPings.deviceId,
			version: telemetryPings.version,
			platform: telemetryPings.platform,
			lastSeenAt: telemetryPings.lastSeenAt
		})
		.from(telemetryPings)
		.where(gte(telemetryPings.date, cutoffDate))
		.orderBy(desc(telemetryPings.date))
		.all();

	const dayMap = new Map<
		string,
		{
			devices: Set<string>;
			versions: Record<string, number>;
			platforms: Record<string, number>;
		}
	>();

	const overallVersions: Record<string, number> = {};
	const overallPlatforms: Record<string, number> = {};
	const wauDevices = new Set<string>();
	const mauDevices = new Set<string>();

	for (const row of rows) {
		let dayEntry = dayMap.get(row.date);
		if (!dayEntry) {
			dayEntry = {
				devices: new Set(),
				versions: {},
				platforms: {}
			};
			dayMap.set(row.date, dayEntry);
		}

		dayEntry.devices.add(row.deviceId);
		dayEntry.versions[row.version] = (dayEntry.versions[row.version] ?? 0) + 1;
		dayEntry.platforms[row.platform] = (dayEntry.platforms[row.platform] ?? 0) + 1;

		mauDevices.add(row.deviceId);
		if (row.date >= sevenDaysAgoDate) {
			wauDevices.add(row.deviceId);
		}

		overallVersions[row.version] = (overallVersions[row.version] ?? 0) + 1;
		overallPlatforms[row.platform] = (overallPlatforms[row.platform] ?? 0) + 1;
	}

	const history: DayStats[] = Array.from(dayMap.entries())
		.map(([date, d]) => ({
			date,
			dau: d.devices.size,
			versions: d.versions,
			platforms: d.platforms
		}))
		.sort((a, b) => b.date.localeCompare(a.date));

	const todayEntry = dayMap.get(todayDate);
	const yesterdayEntry = dayMap.get(yesterdayDate);

	const summary: TelemetrySummary = {
		today: todayEntry ? todayEntry.devices.size : 0,
		yesterday: yesterdayEntry ? yesterdayEntry.devices.size : 0,
		wau: wauDevices.size,
		mau: mauDevices.size,
		totalPings: rows.length,
		versions: overallVersions,
		platforms: overallPlatforms
	};

	return { summary, history };
}

/**
 * Loescht alte Rohdaten aus `telemetry_pings`, die aelter als `retentionDays` Tage sind.
 */
export function cleanupOldTelemetry(
	rawOrDb: Database.Database | DbLike,
	retentionDays = 90,
	now = Date.now()
): number {
	const cutoffDate = toIsoDate(now - retentionDays * 86_400_000);
	if ("prepare" in rawOrDb && typeof (rawOrDb as Database.Database).prepare === "function") {
		const res = (rawOrDb as Database.Database)
			.prepare("DELETE FROM telemetry_pings WHERE date < ?")
			.run(cutoffDate);
		return res.changes;
	}

	// Falls Drizzle-Instanz uebergeben
	const db = rawOrDb as Db;
	const res = db.delete(telemetryPings).where(sql`${telemetryPings.date} < ${cutoffDate}`).run();
	return Number(res.changes ?? 0);
}

