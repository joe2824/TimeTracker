// Die Datenbank: eine SQLite-Datei im selben Prozess.
//
// Warum nicht Postgres: der einzige heisse Pfad ist ein Bereichsscan ueber
// (user_id, seq). Keine Verknuepfungen, keine Aggregate, keine Volltextsuche -
// der Server KANN nichts rechnen, er sieht nur Chiffrate. Fuer dieses Muster ist
// SQLite im Prozess schneller als alles, was ueber einen Socket geht, und es
// kostet keinen zweiten Container.
//
// Der Engpass waere der einzelne Schreiber (WAL laesst genau einen zu). Da die
// Schreibvorgaenge winzig sind und Mikrosekunden dauern, traegt das hunderte
// gleichzeitig aktive Konten. Gewechselt wird, wenn SQLITE_BUSY messbar in den
// Logs auftaucht oder mehr als eine Instanz laufen muss - beides zusammen mit
// Redis fuer das Weiterreichen der Ereignisse.
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import * as schema from "./schema";

/**
 * Die Schema-Schritte, in ihrer Reihenfolge.
 *
 * Bewusst als Liste von SQL-Anweisungen im Programm statt als Dateien neben dem
 * Abbild: das Docker-Abbild bleibt eine Datei, und ein Start kann nicht daran
 * scheitern, dass ein Migrationsordner fehlt. Jeder Schritt laeuft genau einmal;
 * angehaengt wird nur unten, nie dazwischen.
 */
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
	`CREATE INDEX IF NOT EXISTS pairings_user ON pairings(user_id)`
];

export type Db = ReturnType<typeof drizzle<typeof schema>>;

/**
 * Die Datenbank ODER eine laufende Transaktion.
 *
 * Drizzle gibt dem Rueckruf einer Transaktion einen eigenen Typ. Funktionen, die
 * in beiden Zusammenhaengen laufen sollen - und das sollen fast alle - nehmen
 * deshalb diesen hier. Ohne das muesste jeder Aufrufer casten, und ein Cast ist
 * genau die Stelle, an der spaeter ein echter Fehler durchrutscht.
 */
export type DbLike = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];

export interface OpenedDb {
	db: Db;
	raw: Database.Database;
}

/**
 * Die Datenbank oeffnen und auf den aktuellen Stand bringen.
 *
 * `:memory:` ist ausdruecklich erlaubt - die Tests laufen damit, ohne eine Datei
 * anzufassen.
 */
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
