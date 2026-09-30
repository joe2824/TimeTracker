import DatabaseConstructor from "better-sqlite3";
import type { BackupInfo } from "$shared/apiTypes";
export type { BackupInfo };
import type Database from "better-sqlite3";
import { mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { BACKUP_DIR, BACKUP_INTERVAL_HOURS, BACKUP_KEEP } from "./config";
import { migrate } from "./db/index";

const BACKUP_PREFIX = "timetracker-backup-";
const BACKUP_SUFFIX = ".db";

/** Ob ein Name eine Sicherung dieses Servers bezeichnet - und nicht aus dem Ordner herausführt. */
export function isBackupName(name: string): boolean {
	return (
		name.startsWith(BACKUP_PREFIX) &&
		name.endsWith(BACKUP_SUFFIX) &&
		!name.includes("..") &&
		!name.includes("/") &&
		!name.includes("\\")
	);
}

function backupNames(dir: string): string[] {
	return readdirSync(dir).filter(isBackupName);
}

/** Formatierter Zeitstempel für den Dateinamen (z.B. 2026-08-30_10-00-00). */
function formatTimestamp(): string {
	const d = new Date();
	const pad = (n: number) => String(n).padStart(2, "0");
	const datePart = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
	const timePart = `${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
	return `${datePart}_${timePart}`;
}

/** Prüft die Integrität einer erstellten SQLite-Sicherung. */
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

/** Alte Sicherungen aufräumen, damit der Speicherplatz nicht vollläuft. */
export function cleanupBackups(dir: string, keepCount: number): number {
	if (keepCount <= 0) return 0;
	try {
		const files = backupNames(dir)
			.map((f) => {
				const full = join(dir, f);
				return { name: f, path: full, mtime: statSync(full).mtimeMs };
			})
			.sort((a, b) => b.mtime - a.mtime);

		let deletedCount = 0;
		if (files.length > keepCount) {
			const toDelete = files.slice(keepCount);
			for (const file of toDelete) {
				try {
					unlinkSync(file.path);
					deletedCount++;
				} catch (err) {
					console.warn(`[Backup] Konnte alte Sicherung ${file.name} nicht löschen:`, err);
				}
			}
		}
		return deletedCount;
	} catch {
		return 0;
	}
}

/**
 * Ergebnis der Integritätsprüfung je Datei. quick_check liest die ganze Datei -
 * bei jedem Aufruf der Liste über alle Sicherungen wäre das spürbar langsam.
 * Ändern sich Grösse oder Zeitstempel, wird neu geprüft.
 */
const integrityCache = new Map<string, { mtime: number; size: number; verified: boolean }>();

function cachedIntegrity(path: string, mtime: number, size: number): boolean {
	const hit = integrityCache.get(path);
	if (hit && hit.mtime === mtime && hit.size === size) return hit.verified;
	const verified = verifyBackupIntegrity(path);
	integrityCache.set(path, { mtime, size, verified });
	return verified;
}

/** Alle verfügbaren Sicherungen auflisten (neueste zuerst). */
export function listBackups(dir: string = BACKUP_DIR): BackupInfo[] {
	try {
		mkdirSync(dir, { recursive: true });
		return backupNames(dir)
			.map((f) => {
				const full = join(dir, f);
				const st = statSync(full);
				return {
					name: f,
					size: st.size,
					mtime: Math.round(st.mtimeMs),
					verified: cachedIntegrity(full, st.mtimeMs, st.size)
				};
			})
			.sort((a, b) => b.mtime - a.mtime);
	} catch {
		return [];
	}
}

/** Einzelne Sicherungsdatei löschen (mit Path-Traversal-Schutz). */
export function deleteBackupFile(dir: string, name: string): boolean {
	const cleanName = name.trim();
	if (!isBackupName(cleanName)) return false;
	try {
		const full = join(dir, cleanName);
		unlinkSync(full);
		return true;
	} catch {
		return false;
	}
}

/**
 * Stellt eine Sicherung in der aktiven Live-Datenbank wieder her.
 * Erstellt zur Sicherheit vorab ein Sicherheits-Backup des aktuellen Live-Zustands.
 */
export async function restoreBackup(
	liveDb: Database.Database,
	dbPath: string,
	name: string,
	opts: { dir?: string } = {}
): Promise<{ ok: boolean; restored: string; preRestoreBackup: string }> {
	const dir = opts.dir ?? BACKUP_DIR;
	const cleanName = name.trim();
	if (!isBackupName(cleanName)) throw new Error("Ungültiger Dateiname für Sicherung");

	const backupPath = join(dir, cleanName);
	if (!verifyBackupIntegrity(backupPath)) {
		throw new Error("Die Sicherungsdatei ist beschädigt oder keine gültige SQLite-Datenbank");
	}

	// 1. Vorab-Sicherheits-Backup des aktuellen Bestands anlegen. Ohne
	// Aufräumen (keep: 0): sonst fiele bei voller Aufbewahrung ausgerechnet die
	// älteste Sicherung weg - und das kann genau die sein, die zurück soll.
	const preRestore = await performBackup(liveDb, {
		dir,
		keep: 0,
		customName: `${BACKUP_PREFIX}pre-restore-${formatTimestamp()}${BACKUP_SUFFIX}`,
		verify: true
	});

	// 2. Aus der Sicherung über SQLite Backup API in die Live-Datei schreiben
	const backupDb = new DatabaseConstructor(backupPath, { readonly: true });
	try {
		await backupDb.backup(dbPath);
	} finally {
		backupDb.close();
	}

	// 3. WAL checkpointen und Tabellen synchronisieren
	try {
		liveDb.pragma("wal_checkpoint(TRUNCATE)");
	} catch {
		/* ignore */
	}

	// 4. Eine Sicherung aus einer älteren Fassung hat ein älteres Schema - ohne
	// diesen Schritt liefe der Server bis zum nächsten Neustart dagegen.
	migrate(liveDb);

	return { ok: true, restored: cleanName, preRestoreBackup: preRestore.name };
}

/** Eine Sicherung im laufenden Betrieb durchführen (atomar & konsistent). */
export async function performBackup(
	raw: Database.Database,
	opts: { dir?: string; keep?: number; customName?: string; verify?: boolean } = {}
): Promise<{ path: string; name: string; pruned: number; verified: boolean }> {
	const dir = opts.dir ?? BACKUP_DIR;
	const keep = opts.keep ?? BACKUP_KEEP;
	const verify = opts.verify ?? true;

	mkdirSync(dir, { recursive: true });

	const name = opts.customName ?? `${BACKUP_PREFIX}${formatTimestamp()}${BACKUP_SUFFIX}`;
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

	const triggerBackup = async (reason: string) => {
		try {
			const { name, pruned } = await performBackup(raw);
			const info = pruned > 0 ? ` (${pruned} alte Sicherung(en) gelöscht)` : "";
			console.log(`[Backup] ${reason}: ${name}${info}`);
		} catch (err) {
			console.error("[Backup] Fehler bei automatischer Sicherung:", err);
		}
	};

	// Erste Sicherung 60 Sekunden nach Serverstart (falls noch nie eine existiert)
	setTimeout(() => {
		try {
			if (backupNames(BACKUP_DIR).length === 0) {
				triggerBackup("Erste Sicherung nach Serverstart");
			}
		} catch {
			triggerBackup("Erste Sicherung nach Serverstart");
		}
	}, 60_000).unref();

	// Regelmässiger Zeitgeber
	setInterval(() => {
		triggerBackup("Regelmäßige Sicherung");
	}, intervalMs).unref();
}

