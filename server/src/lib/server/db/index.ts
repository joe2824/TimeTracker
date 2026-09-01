// Die Datenbank: eine SQLite-Datei im selben Prozess.
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import * as schema from "./schema";

/** Die Schema-Schritte, in ihrer Reihenfolge. */
const MIGRATIONS: string[] = [
	`CREATE TABLE IF NOT EXISTS users (
		id TEXT PRIMARY KEY,
		display_name TEXT NOT NULL,
		email TEXT,
		created_at INTEGER NOT NULL,
		seq_counter INTEGER NOT NULL DEFAULT 0
	)`,
	`CREATE TABLE IF NOT EXISTS credentials (
		id TEXT PRIMARY KEY,
		user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
		public_key BLOB NOT NULL,
		counter INTEGER NOT NULL DEFAULT 0,
		transports TEXT,
		has_prf INTEGER NOT NULL DEFAULT 0,
		created_at INTEGER NOT NULL,
		last_used_at INTEGER
	)`,
	`CREATE INDEX IF NOT EXISTS credentials_user ON credentials(user_id)`,
	`CREATE TABLE IF NOT EXISTS key_wraps (
		id TEXT PRIMARY KEY,
		user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
		kind TEXT NOT NULL,
		credential_id TEXT,
		payload TEXT NOT NULL,
		created_at INTEGER NOT NULL
	)`,
	`CREATE INDEX IF NOT EXISTS key_wraps_user ON key_wraps(user_id)`,
	`CREATE TABLE IF NOT EXISTS devices (
		id TEXT PRIMARY KEY,
		user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
		label TEXT NOT NULL,
		token_hash TEXT NOT NULL,
		created_at INTEGER NOT NULL,
		last_seen_at INTEGER,
		revoked_at INTEGER
	)`,
	`CREATE INDEX IF NOT EXISTS devices_user ON devices(user_id)`,
	`CREATE UNIQUE INDEX IF NOT EXISTS devices_token ON devices(token_hash)`,
	`CREATE TABLE IF NOT EXISTS records (
		user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
		id TEXT NOT NULL,
		kind TEXT NOT NULL,
		bucket TEXT,
		seq INTEGER NOT NULL,
		rev INTEGER NOT NULL,
		updated_at INTEGER NOT NULL,
		device_id TEXT,
		deleted_at INTEGER,
		payload TEXT
	)`,
	`CREATE UNIQUE INDEX IF NOT EXISTS records_pk ON records(user_id, id)`,
	`CREATE INDEX IF NOT EXISTS records_seq ON records(user_id, seq)`,
	`CREATE INDEX IF NOT EXISTS records_bucket ON records(user_id, bucket)`,
	`CREATE TABLE IF NOT EXISTS sessions (
		id TEXT PRIMARY KEY,
		user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
		created_at INTEGER NOT NULL,
		expires_at INTEGER NOT NULL
	)`,
	`CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id)`,
	`CREATE TABLE IF NOT EXISTS challenges (
		id TEXT PRIMARY KEY,
		challenge TEXT NOT NULL,
		user_id TEXT,
		purpose TEXT NOT NULL,
		expires_at INTEGER NOT NULL
	)`,
	`CREATE TABLE IF NOT EXISTS invites (
		code TEXT PRIMARY KEY,
		created_at INTEGER NOT NULL,
		used_at INTEGER,
		used_by TEXT
	)`,
	// user_id ohne Fremdschluessel und ohne NOT NULL: ein Kopplungsvorgang
	// beginnt auf dem NEUEN Geraet, also bevor feststeht, zu welchem Konto er
	// gehoert. Erst das Bestaetigen traegt es ein.
	`CREATE TABLE IF NOT EXISTS pairings (
		code TEXT PRIMARY KEY,
		user_id TEXT,
		public_key TEXT NOT NULL,
		label TEXT NOT NULL,
		wrapped_key TEXT,
		device_token TEXT,
		created_at INTEGER NOT NULL,
		expires_at INTEGER NOT NULL
	)`,
	`CREATE INDEX IF NOT EXISTS pairings_user ON pairings(user_id)`,
	// Ab hier: nur angehaengt, nie dazwischen. Jeder Schritt laeuft genau einmal.
	`ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0`,
	`ALTER TABLE invites ADD COLUMN created_by TEXT`,
	`ALTER TABLE invites ADD COLUMN note TEXT`,
	`ALTER TABLE invites ADD COLUMN expires_at INTEGER`,
	`ALTER TABLE invites ADD COLUMN revoked_at INTEGER`,
	`ALTER TABLE credentials ADD COLUMN label TEXT`,
	`ALTER TABLE users ADD COLUMN recovery_id TEXT`,
	`ALTER TABLE users ADD COLUMN vault_proof TEXT`,
	// Eindeutig: zwei Konten mit derselben Kennung waeren zwei Konten mit
	// derselben Phrase - das kann nicht sein und darf nicht entstehen.
	`CREATE UNIQUE INDEX IF NOT EXISTS users_recovery ON users(recovery_id) WHERE recovery_id IS NOT NULL`,
	// Der Kopplungscode allein reicht nicht mehr zum Abholen: er ist der Abdruck
	// des Geraeteschluessels, also zwangslaeufig sichtbar. Das Abhol-Geheimnis
	// bleibt dagegen auf dem Geraet, das die Kopplung begonnen hat.
	`ALTER TABLE pairings ADD COLUMN claim_hash TEXT`,
	`CREATE TABLE IF NOT EXISTS server_settings (
		key TEXT PRIMARY KEY,
		value TEXT NOT NULL,
		updated_at INTEGER NOT NULL
	)`,
	// Der Abgleich holt einen Bucket immer der Reihe nach ab. Ohne `seq` im Index
	// findet SQLite zwar die Zeilen, muss sie aber jedes Mal nachsortieren.
	`CREATE INDEX IF NOT EXISTS records_bucket_seq ON records(user_id, bucket, seq)`,
	// Der alte Index ist damit ein Praefix des neuen und kostet nur noch beim Schreiben.
	`DROP INDEX IF EXISTS records_bucket`,

	`CREATE TABLE IF NOT EXISTS telemetry_pings (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		date TEXT NOT NULL,
		device_id TEXT NOT NULL,
		version TEXT NOT NULL,
		platform TEXT NOT NULL,
		last_seen_at INTEGER NOT NULL
	)`,
	`CREATE UNIQUE INDEX IF NOT EXISTS telemetry_pings_date_device ON telemetry_pings(date, device_id)`,
	`CREATE INDEX IF NOT EXISTS telemetry_pings_date ON telemetry_pings(date)`
];



export type Db = ReturnType<typeof drizzle<typeof schema>>;

/** Die Datenbank ODER eine laufende Transaktion. */
export type DbLike = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];

export interface OpenedDb {
	db: Db;
	raw: Database.Database;
}

/** Die Datenbank oeffnen und auf den aktuellen Stand bringen. */
export function openDb(file: string): OpenedDb {
	if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true });
	const raw = new Database(file);
	// WAL: Leser blockieren den Schreiber nicht. Ohne das steht bei jedem
	// Abgleich, der laenger dauert, jeder andere Zugriff still.
	raw.pragma("journal_mode = WAL");
	// NORMAL statt FULL: bei WAL gilt das als sicher gegen Programmabstuerze,
	// nur ein Stromausfall kann die letzten Sekunden kosten. Der Unterschied in
	// der Schreibgeschwindigkeit ist eine Groessenordnung.
	raw.pragma("synchronous = NORMAL");
	raw.pragma("foreign_keys = ON");
	// Geloeschte Inhalte mit Nullen ueberschreiben, statt die Seite nur als frei
	// zu markieren.
	raw.pragma("secure_delete = ON");
	// Eine Sperre nicht sofort aufgeben, sondern kurz warten: sonst scheitert ein
	// Schreibvorgang, nur weil gerade ein anderer laeuft.
	raw.pragma("busy_timeout = 5000");

	migrate(raw);
	return { db: drizzle(raw, { schema }), raw };
}

function migrate(raw: Database.Database): void {
	raw.exec(`CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)`);
	const row = raw.prepare(`SELECT version FROM schema_version LIMIT 1`).get() as
		| { version: number }
		| undefined;
	const from = row?.version ?? 0;
	if (from >= MIGRATIONS.length) return;

	// Alles oder nichts: ein halb migriertes Schema waere schlimmer als ein
	// Server, der nicht startet.
	raw.transaction(() => {
		for (let i = from; i < MIGRATIONS.length; i++) raw.exec(MIGRATIONS[i]);
		if (row) raw.prepare(`UPDATE schema_version SET version = ?`).run(MIGRATIONS.length);
		else raw.prepare(`INSERT INTO schema_version (version) VALUES (?)`).run(MIGRATIONS.length);
	})();
}

export { schema };
