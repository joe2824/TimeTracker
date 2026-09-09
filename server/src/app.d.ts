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
			/** Gesetzt, wenn die Anfrage von einem gekoppelten Gerät kommt. */
			deviceId: string | null;
			/**
			 * Gesetzt, wenn die Anfrage von einem Team-Mitglied kommt (eigener
			 * Token-Raum, `x-team-token` - siehe teams.ts). Unabhängig von
			 * userId/deviceId: ein Team-Mitglied hat kein Personenkonto.
			 */
			teamMemberId: string | null;
			/** Zu welchem Team das Mitglied gehört - nur gesetzt zusammen mit teamMemberId. */
			teamId: string | null;
		}
	}
}

export {};
