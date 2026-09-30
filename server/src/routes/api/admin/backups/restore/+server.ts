// Server-Backup wiederherstellen - nur für Verwalter.
import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { restoreBackup } from "$lib/server/backup";
import { requireAdmin } from "$lib/server/guards";
import { BACKUP_DIR, DB_FILE } from "$lib/server/config";
import { readJson } from "$lib/server/request";

/** Verwalter-Rolle prüfen. */
export const POST: RequestHandler = async ({ locals, request }) => {
	requireAdmin(locals);
	const body = await readJson(request);
	const name = String(body?.name ?? "").trim();
	if (!name) error(400, "Dateiname der wiederherzustellenden Sicherung fehlt");

	try {
		const res = await restoreBackup(locals.raw, locals.dbPath || DB_FILE, name, {
			dir: BACKUP_DIR
		});
		return json(res);
	} catch (err) {
		error(500, err instanceof Error ? err.message : "Wiederherstellung fehlgeschlagen");
	}
};
