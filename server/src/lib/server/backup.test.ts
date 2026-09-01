import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb } from "./db";
import {
	cleanupBackups,
	deleteBackupFile,
	listBackups,
	performBackup,
	restoreBackup,
	verifyBackupIntegrity
} from "./backup";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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

		// Mit keep=3 ausfuehren -> aelteste muessen aufgeraeumt werden
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

		// Intakte DB pruefen
		const fs = require("node:fs");
		const ok = verifyBackupIntegrity(dbFile);
		expect(ok).toBe(true);

		// Korrupte Datei pruefen
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

		// Zustand in Live-DB aendern
		raw.exec("UPDATE custom SET val = 'zustand_2';");
		const rowBefore = raw.prepare("SELECT val FROM custom").get() as { val: string };
		expect(rowBefore.val).toBe("zustand_2");

		// Backup 1 wiederherstellen
		const res = await restoreBackup(raw, dbFile, b1.name, { dir: backupDir });
		expect(res.ok).toBe(true);
		expect(res.restored).toBe(b1.name);
		expect(res.preRestoreBackup).toMatch(/^timetracker-backup-pre-restore-/);

		// Pruefen, dass Zustand 1 wieder da ist
		const rowAfter = raw.prepare("SELECT val FROM custom").get() as { val: string };
		expect(rowAfter.val).toBe("zustand_1");

		raw.close();
	});
});

