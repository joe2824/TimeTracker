// Die Verwalter eines Teams - Chef und Verwalter sehen die Liste, nur der
// Chef darf jemanden wieder aussetzen.
import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { listTeamAdmins, removeTeamAdmin, requireOwnTeam, requireTeamAccess } from "$lib/server/teams";

export const GET: RequestHandler = ({ locals, params }) => {
	if (!locals.userId) error(401, "Nicht angemeldet");
	requireTeamAccess(locals.db, locals.userId, params.teamId!);
	return json({ admins: listTeamAdmins(locals.db, params.teamId!) });
};

export const DELETE: RequestHandler = async ({ locals, params, request }) => {
	if (!locals.userId) error(401, "Nicht angemeldet");
	requireOwnTeam(locals.db, locals.userId, params.teamId!);
	const body = await request.json().catch(() => null);
	const userId = String(body?.userId ?? "");
	if (!userId) error(400, "userId fehlt");
	removeTeamAdmin(locals.db, params.teamId!, userId);
	return json({ ok: true });
};
