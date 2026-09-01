// Server-Backups verwalten - nur fuer Verwalter.
import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { deleteBackupFile, listBackups, performBackup } from "$lib/server/backup";
import { isAdminUser } from "$lib/server/invites";
import { BACKUP_DIR } from "$lib/server/config";

/** Verwalter-Rolle pruefen. */
function requireAdmin(locals: App.Locals): string {
	if (!locals.userId) error(401, "Nicht angemeldet");
	if (!isAdminUser(locals.db, locals.userId)) error(403, "Keine Berechtigung");
	return locals.userId;
}

export const GET: RequestHandler = ({ locals }) => {
	requireAdmin(locals);
	const backups = listBackups(BACKUP_DIR);
	return json({ backups });
};

export const POST: RequestHandler = async ({ locals }) => {
	requireAdmin(locals);
	try {
		const res = await performBackup(locals.raw, { dir: BACKUP_DIR, verify: true });
		return json({ ok: true, backup: res }, { status: 201 });
	} catch (err) {
		error(500, err instanceof Error ? err.message : "Sicherung konnte nicht erstellt werden");
	}
};

export const DELETE: RequestHandler = async ({ locals, request }) => {
	requireAdmin(locals);
	const body = await request.json().catch(() => null);
	const name = String(body?.name ?? "").trim();
	if (!name) error(400, "Dateiname der Sicherung fehlt");

	const isDeleted = deleteBackupFile(BACKUP_DIR, name);
	if (!isDeleted) {
		error(404, "Sicherungsdatei nicht gefunden oder ungültiger Name");
	}
	return json({ ok: true, name });
};
