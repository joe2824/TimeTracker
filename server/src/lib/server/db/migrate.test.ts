// Was passiert, wenn eine gewachsene Datenbank auf den aktuellen Stand kommt.
//
// Anlass: `pairings.user_id` war einmal NOT NULL, die Definition wurde später
// an Ort und Stelle geändert statt als Schritt angehängt. Eine frische
// Datenbank bekam damit die richtige Form, eine gewachsene behielt die alte -
// und auf ihr scheiterte JEDE Kopplung mit "NOT NULL constraint failed",
// sichtbar als drei rote "Internal Error" beim Anzeigen des Kopplungscodes.
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb, MIGRATIONS } from "./index";

/**
 * Wo der Reparatur-Schritt im echten Verlauf steht - nicht geraten (z.B. "der
 * letzte Schritt"), sonst bricht das bei jedem künftigen Anhängen erneut, wie
 * es hier beim Hinzufügen der Team-Migrationen geschehen ist.
 */
const PAIRINGS_FIX_INDEX = MIGRATIONS.findIndex((m) => m.includes("CREATE TABLE pairings_new"));

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
 * `pairings` zurück auf die alte Form und den Stand um eins zurückgedreht.
 *
 * Der Umweg über `openDb` statt eines von Hand gebauten Altbestands hält den
 * Test an der echten Schrittliste - er zählt nicht mit, wie viele es sind.
 */
function agedDatabase(): void {
	openDb(file).raw.close();
	const raw = new Database(file);
	raw.exec("DROP TABLE pairings");
	raw.exec(OLD_PAIRINGS);
	raw.exec("CREATE INDEX IF NOT EXISTS pairings_user ON pairings(user_id)");
	// Genau auf den Stand VOR dem Reparatur-Schritt zurück - nicht "einen
	// Schritt", das wäre nur richtig, solange er der letzte im Verlauf ist.
	raw.prepare("UPDATE schema_version SET version = ?").run(PAIRINGS_FIX_INDEX);
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
		/* Aufräumen darf den Lauf nicht kippen */
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
		// Ohne Reparatur scheitert das Einfügen an der NOT-NULL-Spalte.
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

/** Der Stand von v1.0.0 endete mit dem Neubau von `pairings`; danach kamen die Team-Tabellen. */
const V1_0_0_COUNT = MIGRATIONS.findIndex((m) => m.includes("CREATE TABLE IF NOT EXISTS teams ("));

/** Eine Datenbank genau im Stand von v1.0.0, mit typischem Bestand. */
function v100Database(): void {
	const raw = new Database(file);
	raw.pragma("foreign_keys = ON");
	raw.exec(`CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)`);
	for (const step of MIGRATIONS.slice(0, V1_0_0_COUNT)) raw.exec(step);
	raw.prepare(`INSERT INTO schema_version (version) VALUES (?)`).run(V1_0_0_COUNT);

	raw.prepare(
		`INSERT INTO users (id, display_name, email, created_at, seq_counter, is_admin, recovery_id, vault_proof)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
	).run("user-anna", "Anna Meier", "anna@firma.de", 1000, 7, 1, "rec-anna", "proof");
	raw.prepare(
		`INSERT INTO credentials (id, user_id, public_key, counter, transports, created_at, last_used_at, label)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
	).run("cred-1", "user-anna", Buffer.from([1, 2, 3]), 4, "internal", 1001, 1002, "Laptop");
	raw.prepare(
		`INSERT INTO key_wraps (id, user_id, kind, credential_id, payload, created_at) VALUES (?, ?, ?, ?, ?, ?)`
	).run("wrap-1", "user-anna", "prf", "cred-1", "verpackt", 1003);
	raw.prepare(
		`INSERT INTO devices (id, user_id, label, token_hash, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)`
	).run("dev-1", "user-anna", "Büro-PC", "hash-1", 1004, 1005);
	raw.prepare(
		`INSERT INTO records (user_id, id, kind, bucket, seq, rev, updated_at, device_id, payload)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
	).run("user-anna", "rec-1", "entries", "2026-05", 7, 2, 1006, "dev-1", "chiffre");
	raw.prepare(
		`INSERT INTO pairings (code, user_id, public_key, label, claim_hash, created_at, expires_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?)`
	).run("PAIRCODE0001", "user-anna", "oeffentlich", "Tablet", "claim", 1007, 9999);
	raw.prepare(
		`INSERT INTO invites (code, created_at, created_by, note, expires_at) VALUES (?, ?, ?, ?, ?)`
	).run("INVITE-1", 1008, "user-anna", "für das Team", 99999);
	raw.close();
}

describe("Migration einer v1.0.0-Datenbank mit Bestand", () => {
	it("kennt den Stand von v1.0.0 im Verlauf", () => {
		expect(V1_0_0_COUNT).toBeGreaterThan(PAIRINGS_FIX_INDEX);
		expect(MIGRATIONS[V1_0_0_COUNT - 1]).toContain("CREATE TABLE pairings_new");
	});

	it("behält alle Zeilen und erreicht den aktuellen Stand", () => {
		v100Database();
		const { raw } = openDb(file);
		const version = raw.prepare("SELECT version FROM schema_version").get() as { version: number };
		expect(version.version).toBe(MIGRATIONS.length);

		const user = raw.prepare("SELECT * FROM users WHERE id = ?").get("user-anna") as Record<string, unknown>;
		expect(user).toMatchObject({
			display_name: "Anna Meier",
			email: "anna@firma.de",
			seq_counter: 7,
			is_admin: 1,
			recovery_id: "rec-anna"
		});
		expect(raw.prepare("SELECT label, counter FROM credentials WHERE id = 'cred-1'").get()).toEqual({
			label: "Laptop",
			counter: 4
		});
		expect(raw.prepare("SELECT payload FROM key_wraps WHERE id = 'wrap-1'").get()).toEqual({ payload: "verpackt" });
		expect(raw.prepare("SELECT label, token_hash FROM devices WHERE id = 'dev-1'").get()).toEqual({
			label: "Büro-PC",
			token_hash: "hash-1"
		});
		expect(raw.prepare("SELECT payload, seq, rev FROM records WHERE id = 'rec-1'").get()).toEqual({
			payload: "chiffre",
			seq: 7,
			rev: 2
		});
		expect(raw.prepare("SELECT user_id, claim_hash FROM pairings WHERE code = 'PAIRCODE0001'").get()).toEqual({
			user_id: "user-anna",
			claim_hash: "claim"
		});
		expect(raw.prepare("SELECT note, created_by FROM invites WHERE code = 'INVITE-1'").get()).toEqual({
			note: "für das Team",
			created_by: "user-anna"
		});
		raw.close();
	});

	it("die Team-Tabellen sind danach beschreibbar", () => {
		v100Database();
		const { raw } = openDb(file);
		expect(() => {
			raw.prepare("INSERT INTO teams (id, owner_user_id, name, created_at) VALUES (?, ?, ?, ?)").run(
				"team-1",
				"user-anna",
				"Pflege",
				2000
			);
			raw.prepare(
				"INSERT INTO team_members (id, team_id, name, token_hash, created_at) VALUES (?, ?, ?, ?, ?)"
			).run("mem-1", "team-1", "Anna Meier", "thash", 2001);
			raw.prepare(
				"INSERT INTO team_invites (code, team_id, created_at) VALUES (?, ?, ?)"
			).run("TINV", "team-1", 2002);
			raw.prepare(
				"INSERT INTO team_activities (id, team_id, name, sort_order, updated_at) VALUES (?, ?, ?, ?, ?)"
			).run("act-1", "team-1", "Pflege", 0, 2003);
			raw.prepare(
				"INSERT INTO team_reports (team_id, member_id, month, submitted_at, payload) VALUES (?, ?, ?, ?, ?)"
			).run("team-1", "mem-1", "2026-05", 2004, "{}");
			raw.prepare("INSERT INTO team_admin_invites (code, team_id, created_at) VALUES (?, ?, ?)").run(
				"AINV",
				"team-1",
				2005
			);
			raw.prepare("INSERT INTO team_admins (team_id, user_id, created_at) VALUES (?, ?, ?)").run(
				"team-1",
				"user-anna",
				2006
			);
		}).not.toThrow();
		expect(raw.prepare("SELECT count(*) AS n FROM team_reports").get()).toEqual({ n: 1 });
		raw.close();
	});
});
