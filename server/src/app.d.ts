import type { Db } from "$lib/server/db";

declare global {
	namespace App {
		interface Locals {
			db: Db;
			/** Gesetzt, sobald die Anfrage einem Konto zugeordnet ist. */
			userId: string | null;
			/** Gesetzt, wenn die Anfrage von einem gekoppelten Geraet kommt. */
			deviceId: string | null;
		}
	}
}

export {};
