// Fuer den Healthcheck des Containers. Beruehrt die Datenbank, damit ein
// kaputter Datenbestand nicht als "gesund" durchgeht.
import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { sql } from "drizzle-orm";

export const GET: RequestHandler = ({ locals }) => {
	locals.db.get(sql`select 1`);
	return json({ ok: true });
};
