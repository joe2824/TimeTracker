import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { openDb, MIGRATIONS } from "./db/index";
import {
	cleanupBackups,
	deleteBackupFile,
	listBackups,
	performBackup,
	restoreBackup,
	verifyBackupIntegrity
} from "./backup";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("Datenbanksicherungen", () => {
	let dir: string;
	let backupDir: string;
	let dbFile: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "tt-backup-test-"));
		backupDir = join(dir, "backups");
		dbFile = join(dir, "test.db");
	});

	afterEach(() => {
		try {
			rmSync(dir, { recursive: true, force: true });
		} catch {
			/* ignore */
		}
	});

	it("erstellt eine atomare Sicherung der SQLite-Datenbank", async () => {
		const { raw } = openDb(dbFile);
		const result = await performBackup(raw, { dir: backupDir, keep: 5 });

		expect(result.name).toMatch(/^timetracker-backup-\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}\.db$/);
		const files = readdirSync(backupDir);
		expect(files).toContain(result.name);
		expect(result.verified).toBe(true);
		raw.close();
	});

	it("loescht aeltere Sicherungen gemaess Aufbewahrungslimit", async () => {
		const { raw } = openDb(dbFile);

		// 4 alte Fake-Sicherungen anlegen
		const fs = await import("node:fs");
		fs.mkdirSync(backupDir, { recursive: true });
		for (let i = 1; i <= 4; i++) {
			const p = join(backupDir, `timetracker-backup-2026-08-0${i}_12-00-00.db`);
			writeFileSync(p, "alt");
			const time = 1000000 + i * 1000;
			fs.utimesSync(p, time, time);
		}

		// Mit keep=3 ausführen -> älteste müssen aufgeräumt werden
		const result = await performBackup(raw, { dir: backupDir, keep: 3 });

		const files = readdirSync(backupDir).filter((f) => f.startsWith("timetracker-backup-") && f.endsWith(".db"));
		expect(files.length).toBe(3);
		expect(files).toContain(result.name);
		expect(result.pruned).toBeGreaterThanOrEqual(1);

		raw.close();
	});

	it("cleanupBackups raeumt ueberschuessige Dateien auf", () => {
		const fs = require("node:fs");
		fs.mkdirSync(backupDir, { recursive: true });
		for (let i = 1; i <= 5; i++) {
			writeFileSync(join(backupDir, `timetracker-backup-2026-08-0${i}_12-00-00.db`), `test-${i}`);
		}

		const deletedCount = cleanupBackups(backupDir, 2);
		expect(deletedCount).toBe(3);
		const rest = readdirSync(backupDir);
		expect(rest.length).toBe(2);
	});

	it("verifyBackupIntegrity erkennt intakte und korrupte Datenbanken", () => {
		const { raw } = openDb(dbFile);
		raw.exec("CREATE TABLE foo (id INT); INSERT INTO foo VALUES (42);");
		raw.close();

		// Intakte DB prüfen
		const fs = require("node:fs");
		const ok = verifyBackupIntegrity(dbFile);
		expect(ok).toBe(true);

		// Korrupte Datei prüfen
		const corruptedFile = join(dir, "kaputt.db");
		fs.writeFileSync(corruptedFile, "KEINE_SQLITE_DATENBANK");
		const notOk = verifyBackupIntegrity(corruptedFile);
		expect(notOk).toBe(false);
	});

	it("listBackups listet vorhandene Backups mit Metadaten auf", async () => {
		const { raw } = openDb(dbFile);
		await performBackup(raw, { dir: backupDir });
		raw.close();

		const list = listBackups(backupDir);
		expect(list.length).toBe(1);
		expect(list[0].verified).toBe(true);
		expect(list[0].size).toBeGreaterThan(0);
	});

	it("deleteBackupFile loescht existierende Sicherungen und schuetzt vor Traversal", async () => {
		const { raw } = openDb(dbFile);
		const b = await performBackup(raw, { dir: backupDir });
		raw.close();

		expect(deleteBackupFile(backupDir, "../test.db")).toBe(false);
		expect(deleteBackupFile(backupDir, "invalid.txt")).toBe(false);
		expect(deleteBackupFile(backupDir, b.name)).toBe(true);
		expect(listBackups(backupDir).length).toBe(0);
	});

	it("restoreBackup stellt eine Sicherung wieder her und legt ein Pre-Restore Backup an", async () => {
		const { raw } = openDb(dbFile);
		raw.exec("CREATE TABLE custom (val TEXT); INSERT INTO custom VALUES ('zustand_1');");

		// Backup 1 anlegen
		const b1 = await performBackup(raw, { dir: backupDir, customName: "timetracker-backup-2026-08-30_10-00-00.db" });

		// Zustand in Live-DB ändern
		raw.exec("UPDATE custom SET val = 'zustand_2';");
		const rowBefore = raw.prepare("SELECT val FROM custom").get() as { val: string };
		expect(rowBefore.val).toBe("zustand_2");

		// Backup 1 wiederherstellen
		const res = await restoreBackup(raw, dbFile, b1.name, { dir: backupDir });
		expect(res.ok).toBe(true);
		expect(res.restored).toBe(b1.name);
		expect(res.preRestoreBackup).toMatch(/^timetracker-backup-pre-restore-/);

		// Prüfen, dass Zustand 1 wieder da ist
		const rowAfter = raw.prepare("SELECT val FROM custom").get() as { val: string };
		expect(rowAfter.val).toBe("zustand_1");

		raw.close();
	});

	it("stellt auch die aelteste von sieben Sicherungen wieder her", async () => {
		const { raw } = openDb(dbFile);
		raw.exec("CREATE TABLE custom (val TEXT); INSERT INTO custom VALUES ('alt');");
		mkdirSync(backupDir, { recursive: true });
		const names: string[] = [];
		for (let i = 1; i <= 7; i++) {
			const b = await performBackup(raw, {
				dir: backupDir,
				keep: 7,
				customName: `timetracker-backup-2026-08-0${i}_12-00-00.db`
			});
			const time = 1_000_000 + i * 1000;
			utimesSync(b.path, time, time);
			names.push(b.name);
		}
		raw.exec("UPDATE custom SET val = 'neu';");

		const res = await restoreBackup(raw, dbFile, names[0], { dir: backupDir });
		expect(res.ok).toBe(true);
		expect((raw.prepare("SELECT val FROM custom").get() as { val: string }).val).toBe("alt");
		expect(existsSync(join(backupDir, res.preRestoreBackup))).toBe(true);
		raw.close();
	});

	it("bringt eine Sicherung mit aelterem Schema beim Wiederherstellen auf den aktuellen Stand", async () => {
		const agedFile = join(dir, "alt.db");
		openDb(agedFile).raw.close();
		const aged = new Database(agedFile);
		const before = MIGRATIONS.findIndex((m) => m.includes("CREATE TABLE IF NOT EXISTS team_admin_invites"));
		aged.exec("DROP TABLE team_admins; DROP TABLE team_admin_invites;");
		aged.prepare("UPDATE schema_version SET version = ?").run(before);
		mkdirSync(backupDir, { recursive: true });
		await aged.backup(join(backupDir, "timetracker-backup-2026-01-01_00-00-00.db"));
		aged.close();

		const { raw } = openDb(dbFile);
		await restoreBackup(raw, dbFile, "timetracker-backup-2026-01-01_00-00-00.db", { dir: backupDir });

		const version = raw.prepare("SELECT version FROM schema_version").get() as { version: number };
		expect(version.version).toBe(MIGRATIONS.length);
		const table = raw
			.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'team_admins'")
			.get();
		expect(table).toBeTruthy();
		raw.close();
	});
});
