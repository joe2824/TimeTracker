// Server-Backup wiederherstellen - nur fuer Verwalter.
import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { restoreBackup } from "$lib/server/backup";
import { isAdminUser } from "$lib/server/invites";
import { BACKUP_DIR, DB_FILE } from "$lib/server/config";

/** Verwalter-Rolle pruefen. */
function requireAdmin(locals: App.Locals): string {
	if (!locals.userId) error(401, "Nicht angemeldet");
	if (!isAdminUser(locals.db, locals.userId)) error(403, "Keine Berechtigung");
	return locals.userId;
}

export const POST: RequestHandler = async ({ locals, request }) => {
	requireAdmin(locals);
	const body = await request.json().catch(() => null);
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
