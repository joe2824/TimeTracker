import DatabaseConstructor from "better-sqlite3";
import type Database from "better-sqlite3";
import { mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { BACKUP_DIR, BACKUP_INTERVAL_HOURS, BACKUP_KEEP } from "./config";

/** Formatierter Zeitstempel fuer den Dateinamen (z.B. 2026-08-30_10-00-00). */
function zeitstempel(): string {
	const d = new Date();
	const pad = (n: number) => String(n).padStart(2, "0");
	const datum = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
	const zeit = `${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
	return `${datum}_${zeit}`;
}

/** Prueft die Integritaet einer erstellten SQLite-Sicherung. */
export function verifyBackupIntegrity(backupPath: string): boolean {
	try {
		const testDb = new DatabaseConstructor(backupPath, { readonly: true });
		try {
			const res = testDb.pragma("quick_check") as Array<{ quick_check: string }>;
			return Array.isArray(res) && res.length > 0 && res[0]?.quick_check === "ok";
		} finally {
			testDb.close();
		}
	} catch (err) {
		console.warn(`[Backup] Integritätsprüfung fehlgeschlagen für ${backupPath}:`, err);
		return false;
	}
}

/** Alte Sicherungen aufraeumen, damit der Speicherplatz nicht volllaeuft. */
export function cleanupBackups(dir: string, keepCount: number): number {
	if (keepCount <= 0) return 0;
	try {
		const dateien = readdirSync(dir)
			.filter((f) => f.startsWith("timetracker-backup-") && f.endsWith(".db"))
			.map((f) => {
				const full = join(dir, f);
				return { name: f, path: full, mtime: statSync(full).mtimeMs };
			})
			.sort((a, b) => b.mtime - a.mtime);

		let geloescht = 0;
		if (dateien.length > keepCount) {
			const zuLoeschen = dateien.slice(keepCount);
			for (const file of zuLoeschen) {
				try {
					unlinkSync(file.path);
					geloescht++;
				} catch (err) {
					console.warn(`[Backup] Konnte alte Sicherung ${file.name} nicht löschen:`, err);
				}
			}
		}
		return geloescht;
	} catch {
		return 0;
	}
}

/** Eine Sicherung im laufenden Betrieb durchfuehren (atomar & konsistent). */
export async function performBackup(
	raw: Database.Database,
	opts: { dir?: string; keep?: number; customName?: string; verify?: boolean } = {}
): Promise<{ path: string; name: string; pruned: number; verified: boolean }> {
	const dir = opts.dir ?? BACKUP_DIR;
	const keep = opts.keep ?? BACKUP_KEEP;
	const verify = opts.verify ?? true;

	mkdirSync(dir, { recursive: true });

	const name = opts.customName ?? `timetracker-backup-${zeitstempel()}.db`;
	const destPath = join(dir, name);

	await raw.backup(destPath);

	let verified = true;
	if (verify) {
		verified = verifyBackupIntegrity(destPath);
		if (!verified) {
			try {
				unlinkSync(destPath);
			} catch {
				/* ignore */
			}
			throw new Error(`Integritätsprüfung für Backup ${name} fehlgeschlagen.`);
		}
	}

	const pruned = cleanupBackups(dir, keep);

	return { path: destPath, name, pruned, verified };
}

/** Startet den automatischen Backup-Zeitgeber des Servers. */
export function startBackupScheduler(raw: Database.Database): void {
	if (BACKUP_INTERVAL_HOURS <= 0) {
		console.log("[Backup] Automatische Sicherungen sind deaktiviert (BACKUP_INTERVAL_HOURS=0).");
		return;
	}

	const intervalMs = BACKUP_INTERVAL_HOURS * 3600_000;
	console.log(
		`[Backup] Automatische Sicherung aktiv: alle ${BACKUP_INTERVAL_HOURS}h in "${BACKUP_DIR}" (max. ${BACKUP_KEEP} Sicherungen).`
	);

	const fuehreAus = async (anlass: string) => {
		try {
			const { name, pruned } = await performBackup(raw);
			const info = pruned > 0 ? ` (${pruned} alte Sicherung(en) gelöscht)` : "";
			console.log(`[Backup] ${anlass}: ${name}${info}`);
		} catch (err) {
			console.error("[Backup] Fehler bei automatischer Sicherung:", err);
		}
	};

	// Erste Sicherung 60 Sekunden nach Serverstart (falls noch nie eine existiert)
	setTimeout(() => {
		try {
			const dateien = readdirSync(BACKUP_DIR).filter((f) => f.endsWith(".db"));
			if (dateien.length === 0) {
				fuehreAus("Erste Sicherung nach Serverstart");
			}
		} catch {
			fuehreAus("Erste Sicherung nach Serverstart");
		}
	}, 60_000).unref();

	// Regelmaessiger Zeitgeber
	setInterval(() => {
		fuehreAus("Regelmäßige Sicherung");
	}, intervalMs).unref();
}

