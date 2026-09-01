// Anonyme Nutzungsstatistik und Telemetrie auf dem TimeTracker-Server.
// Erfasst ausschliesslich: Datum, anonyme Geraetekennung, App-Version und Betriebssystem/Plattform.
import { gte, sql } from "drizzle-orm";
import type { Db, DbLike } from "./db";
import { telemetryPings } from "./db/schema";
import type Database from "better-sqlite3";

/** Kuerzeste noch brauchbare Geraetekennung. */
export const MIN_DEVICE_ID_LEN = 4;
/**
 * Laengste Geraetekennung. Der Endpunkt weist laengere ab, statt sie hier zu
 * kuerzen: zwei Geraete mit gleichem Anfang fielen sonst ueber den
 * Eindeutigkeits-Index zu einer Zeile zusammen.
 */
export const MAX_DEVICE_ID_LEN = 64;

/** Plattformen, die die Anwendung meldet. Alles andere wird nicht uebernommen. */
const KNOWN_PLATFORMS = new Set([
	"macos",
	"windows",
	"linux",
	"desktop",
	"web",
	"web-mac",
	"web-win",
	"web-linux",
	"unknown"
]);

/** Ziffern, Punkte und die Zusaetze einer Vorabversion - mehr hat eine Version nicht. */
const VERSION_RE = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,31}$/;

/** Wofuer kein brauchbarer Wert ankam. */
const UNKNOWN = "unbekannt";

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
	/** Letzte 7 Tage (eindeutige Geraete), unabhaengig vom abgefragten Verlauf. */
	wau: number;
	/** Letzte 30 Tage (eindeutige Geraete), unabhaengig vom abgefragten Verlauf. */
	mau: number;
	/** Pings im abgefragten Verlauf - je Geraet und Tag hoechstens einer. */
	totalPings: number;
	versions: Record<string, number>;
	platforms: Record<string, number>;
}

export interface TelemetryStatsResult {
	summary: TelemetrySummary;
	history: DayStats[];
}

/** Erzeugt den Datums-String "YYYY-MM-DD" fuer einen Zeitstempel. */
export function toIsoDate(timestamp = Date.now()): string {
	return new Date(timestamp).toISOString().slice(0, 10);
}

/**
 * Nimmt einen anonymen Telemetrie-Ping entgegen und aktualisiert den Tageseintrag (Upsert).
 * Pro Geraet und Tag existiert maximal eine Zeile in der Datenbank.
 */
export function recordTelemetryPing(
	db: DbLike,
	input: TelemetryPingInput
): { ok: boolean; date: string } {
	const deviceId = typeof input.deviceId === "string" ? input.deviceId.trim() : "";
	if (deviceId.length < MIN_DEVICE_ID_LEN || deviceId.length > MAX_DEVICE_ID_LEN) {
		return { ok: false, date: "" };
	}

	// Beides landet ungefiltert in der Verwaltungsansicht. Was nicht wie eine
	// Version bzw. eine bekannte Plattform aussieht, wird nicht uebernommen -
	// sonst genuegen ein paar hundert erfundene Werte, um die Seite unlesbar zu
	// machen.
	const rawVersion = typeof input.version === "string" ? input.version.trim() : "";
	const version = VERSION_RE.test(rawVersion) ? rawVersion : UNKNOWN;
	const rawPlatform = typeof input.platform === "string" ? input.platform.trim().toLowerCase() : "";
	const platform = KNOWN_PLATFORMS.has(rawPlatform) ? rawPlatform : UNKNOWN;

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

/** Eindeutige Geraete ab diesem Datum (einschliesslich). */
function countDevicesSince(db: DbLike, cutoffDate: string): number {
	const row = db
		.select({ n: sql<number>`count(distinct ${telemetryPings.deviceId})` })
		.from(telemetryPings)
		.where(gte(telemetryPings.date, cutoffDate))
		.get();
	return Number(row?.n ?? 0);
}

/**
 * Liest die Telemetrie-Auswertung aus: `days` Tage Verlauf, dazu die
 * Zusammenfassung.
 *
 * WAU und MAU haengen NICHT an `days`, sondern an ihrem eigenen Zeitfenster.
 * Sonst stuende unter "30 Tage" die Zahl eines kuerzeren Verlaufs, sobald jemand
 * weniger Tage abfragt.
 *
 * Gezaehlt wird in SQLite. Je Geraet und Tag gibt es genau eine Zeile
 * (Eindeutigkeits-Index), also ist `count(*)` je Tag schon die Zahl der Geraete.
 */
export function getTelemetryStats(db: DbLike, days = 30, now = Date.now()): TelemetryStatsResult {
	const todayDate = toIsoDate(now);
	const yesterdayDate = toIsoDate(now - 86_400_000);
	// Einschliesslich heute: sieben Tage sind heute und die sechs davor.
	const wauCutoff = toIsoDate(now - 6 * 86_400_000);
	const mauCutoff = toIsoDate(now - 29 * 86_400_000);
	const historyCutoff = toIsoDate(now - (Math.max(1, days) - 1) * 86_400_000);

	const rows = db
		.select({
			date: telemetryPings.date,
			version: telemetryPings.version,
			platform: telemetryPings.platform,
			devices: sql<number>`count(*)`
		})
		.from(telemetryPings)
		.where(gte(telemetryPings.date, historyCutoff))
		.groupBy(telemetryPings.date, telemetryPings.version, telemetryPings.platform)
		.all();

	const dayMap = new Map<string, DayStats>();
	const overallVersions: Record<string, number> = {};
	const overallPlatforms: Record<string, number> = {};
	let totalPings = 0;

	for (const row of rows) {
		const n = Number(row.devices);
		let day = dayMap.get(row.date);
		if (!day) {
			day = { date: row.date, dau: 0, versions: {}, platforms: {} };
			dayMap.set(row.date, day);
		}
		day.dau += n;
		day.versions[row.version] = (day.versions[row.version] ?? 0) + n;
		day.platforms[row.platform] = (day.platforms[row.platform] ?? 0) + n;

		overallVersions[row.version] = (overallVersions[row.version] ?? 0) + n;
		overallPlatforms[row.platform] = (overallPlatforms[row.platform] ?? 0) + n;
		totalPings += n;
	}

	const history = Array.from(dayMap.values()).sort((a, b) => b.date.localeCompare(a.date));

	const summary: TelemetrySummary = {
		today: dayMap.get(todayDate)?.dau ?? 0,
		yesterday: dayMap.get(yesterdayDate)?.dau ?? 0,
		wau: countDevicesSince(db, wauCutoff),
		mau: countDevicesSince(db, mauCutoff),
		totalPings,
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
