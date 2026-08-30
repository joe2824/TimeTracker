import type { Db } from "$lib/server/db";
import type Database from "better-sqlite3";

declare global {
	namespace App {
		interface Locals {
			db: Db;
			raw: Database.Database;
			dbPath: string;
			/** Gesetzt, sobald die Anfrage einem Konto zugeordnet ist. */
			userId: string | null;
			/** Gesetzt, wenn die Anfrage von einem gekoppelten Geraet kommt. */
			deviceId: string | null;
		}
	}
}

export {};
