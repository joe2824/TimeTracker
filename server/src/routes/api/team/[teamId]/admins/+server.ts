// Die Verwalter eines Teams - Leitung und Verwalter sehen die Liste, nur die
// Leitung darf jemanden wieder aussetzen.
import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { listTeamAdmins, removeTeamAdmin, requireOwnTeam, requireTeamAccess } from "$lib/server/teams";
import { readJson } from "$lib/server/request";
import { requireUser } from "$lib/server/guards";

export const GET: RequestHandler = ({ locals, params }) => {
	const userId = requireUser(locals);
	requireTeamAccess(locals.db, userId, params.teamId!);
	return json({ admins: listTeamAdmins(locals.db, params.teamId!) });
};

export const DELETE: RequestHandler = async ({ locals, params, request }) => {
	const userId = requireUser(locals);
	requireOwnTeam(locals.db, userId, params.teamId!);
	const body = await readJson(request);
	const adminUserId = String(body?.userId ?? "");
	if (!adminUserId) error(400, "userId fehlt");
	if (!removeTeamAdmin(locals.db, params.teamId!, adminUserId)) {
		error(404, "Verwalter unbekannt oder schon entfernt");
	}
	return json({ ok: true });
};
