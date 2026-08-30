import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb } from "./db";
import { cleanupBackups, performBackup } from "./backup";
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
		const ergebnis = await performBackup(raw, { dir: backupDir, keep: 5 });

		expect(ergebnis.name).toMatch(/^timetracker-backup-\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}\.db$/);
		const dateien = readdirSync(backupDir);
		expect(dateien).toContain(ergebnis.name);
		raw.close();
	});

	it("loescht aeltere Sicherungen gemaess Aufbewahrungslimit", async () => {
		const { raw } = openDb(dbFile);

		// 4 alte Fake-Sicherungen anlegen
		const fs = await import("node:fs");
		fs.mkdirSync(backupDir, { recursive: true });
		for (let i = 1; i <= 4; i++) {
			writeFileSync(join(backupDir, `timetracker-backup-2026-08-0${i}_12-00-00.db`), "alt");
		}

		// Mit keep=3 ausfuehren -> aelteste muessen aufgeraeumt werden
		const ergebnis = await performBackup(raw, { dir: backupDir, keep: 3 });

		const dateien = readdirSync(backupDir);
		expect(dateien.length).toBe(3);
		expect(dateien).toContain(ergebnis.name);
		expect(ergebnis.pruned).toBeGreaterThanOrEqual(1);

		raw.close();
	});

	it("cleanupBackups raeumt ueberschuessige Dateien auf", () => {
		const fs = require("node:fs");
		fs.mkdirSync(backupDir, { recursive: true });
		for (let i = 1; i <= 5; i++) {
			writeFileSync(join(backupDir, `timetracker-backup-2026-08-0${i}_12-00-00.db`), `test-${i}`);
		}

		const geloescht = cleanupBackups(backupDir, 2);
		expect(geloescht).toBe(3);
		const rest = readdirSync(backupDir);
		expect(rest.length).toBe(2);
	});
});

