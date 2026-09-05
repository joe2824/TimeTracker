// Was die Server-Tests gemeinsam brauchen: eine Datenbank im Speicher mit zwei
// Konten, und das Zuruecksetzen von Umgebungsvariablen nach der Datei.
import { afterAll } from "vitest";
import { openDb, type Db } from "../db/index";
import { users } from "../db/schema";

export const ANNA = "user-anna";
export const BODO = "user-bodo";

/** Ein Konto anlegen - ohne den Weg ueber eine Route. */
export function createUser(db: Db, id: string): void {
	db.insert(users).values({ id, displayName: id, createdAt: 1, seqCounter: 0 }).run();
}

/** Eine frische Datenbank im Speicher, in der ANNA und BODO schon stehen. */
export function freshDb(): Db {
	const db = openDb(":memory:").db;
	createUser(db, ANNA);
	createUser(db, BODO);
	return db;
}

/**
 * Die genannten Umgebungsvariablen nach dieser Datei wieder auf ihren Stand
 * bringen.
 *
 * Vitest verwendet Worker-Prozesse fuer mehrere Test-Dateien wieder, und
 * `process.env` ueberlebt den Wechsel: was stehen bleibt, kippt die naechste
 * Datei.
 */
export function keepEnv(...keys: string[]): void {
	const before = new Map(keys.map((k) => [k, process.env[k]] as const));
	afterAll(() => {
		for (const [k, v] of before) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
	});
}
