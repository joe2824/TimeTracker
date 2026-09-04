// Was passiert, wenn eine gewachsene Datenbank auf den aktuellen Stand kommt.
//
// Anlass: `pairings.user_id` war einmal NOT NULL, die Definition wurde spaeter
// an Ort und Stelle geaendert statt als Schritt angehaengt. Eine frische
// Datenbank bekam damit die richtige Form, eine gewachsene behielt die alte -
// und auf ihr scheiterte JEDE Kopplung mit "NOT NULL constraint failed",
// sichtbar als drei rote "Internal Error" beim Anzeigen des Kopplungscodes.
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb } from "./index";

let dir: string;
let file: string;

/** Die Form, die `pairings` vor der Korrektur hatte. */
const OLD_PAIRINGS = `CREATE TABLE pairings (
	code TEXT PRIMARY KEY,
	user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	public_key TEXT NOT NULL,
	label TEXT NOT NULL,
	wrapped_key TEXT,
	device_token TEXT,
	created_at INTEGER NOT NULL,
	expires_at INTEGER NOT NULL
, claim_hash TEXT)`;

/**
 * Eine Datenbank, wie sie vor dem letzten Schritt aussah: alles migriert, dann
 * `pairings` zurueck auf die alte Form und den Stand um eins zurueckgedreht.
 *
 * Der Umweg ueber `openDb` statt eines von Hand gebauten Altbestands haelt den
 * Test an der echten Schrittliste - er zaehlt nicht mit, wie viele es sind.
 */
function agedDatabase(): void {
	openDb(file).raw.close();
	const raw = new Database(file);
	raw.exec("DROP TABLE pairings");
	raw.exec(OLD_PAIRINGS);
	raw.exec("CREATE INDEX IF NOT EXISTS pairings_user ON pairings(user_id)");
	raw.prepare("UPDATE schema_version SET version = version - 1").run();
	raw.close();
}

/** Genau der Aufruf, an dem `POST /api/pair/start` scheiterte. */
function insertPairing(raw: Database.Database, code: string, userId: string | null): void {
	raw.prepare(
		`INSERT INTO pairings (code, user_id, public_key, label, claim_hash, created_at, expires_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?)`
	).run(code, userId, "oeffentlich", "Neues Gerät", "abc", 1000, 2000);
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "tt-migrate-"));
	file = join(dir, "test.db");
});

afterEach(() => {
	try {
		rmSync(dir, { recursive: true, force: true });
	} catch {
		/* Aufraeumen darf den Lauf nicht kippen */
	}
});

describe("pairings.user_id darf leer sein", () => {
	it("eine frische Datenbank nimmt eine Kopplung ohne Konto an", () => {
		const { raw } = openDb(file);
		expect(() => insertPairing(raw, "AAAABBBBCCCC", null)).not.toThrow();
		raw.close();
	});

	it("eine gewachsene Datenbank wird beim Oeffnen repariert", () => {
		agedDatabase();
		// Vorher: genau der Fehler aus dem Serverprotokoll.
		const before = new Database(file);
		expect(() => insertPairing(before, "AAAABBBBCCCC", null)).toThrow(/NOT NULL/);
		before.close();

		const { raw } = openDb(file);
		expect(() => insertPairing(raw, "AAAABBBBCCCC", null)).not.toThrow();
		raw.close();
	});

	it("nimmt die vorhandenen Kopplungen mit", () => {
		agedDatabase();
		const old = new Database(file);
		old.prepare(
			"INSERT INTO users (id, display_name, created_at, seq_counter) VALUES (?, ?, ?, 0)"
		).run("user-anna", "Anna", 1);
		insertPairing(old, "DDDDEEEEFFFF", "user-anna");
		old.close();

		const { raw } = openDb(file);
		const row = raw.prepare("SELECT * FROM pairings WHERE code = ?").get("DDDDEEEEFFFF") as {
			user_id: string;
			label: string;
			claim_hash: string;
			expires_at: number;
		};
		expect(row.user_id).toBe("user-anna");
		expect(row.label).toBe("Neues Gerät");
		expect(row.claim_hash).toBe("abc");
		expect(row.expires_at).toBe(2000);
		raw.close();
	});

	it("der Index auf user_id steht danach wieder", () => {
		agedDatabase();
		const { raw } = openDb(file);
		const idx = raw
			.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'pairings'")
			.all() as { name: string }[];
		expect(idx.map((i) => i.name)).toContain("pairings_user");
		raw.close();
	});

	it("laeuft ein zweites Mal nicht noch einmal", () => {
		agedDatabase();
		openDb(file).raw.close();
		const { raw } = openDb(file);
		expect(raw.prepare("SELECT sql FROM sqlite_master WHERE name = 'pairings'").get()).toBeTruthy();
		expect(() => insertPairing(raw, "AAAABBBBCCCC", null)).not.toThrow();
		raw.close();
	});
});
