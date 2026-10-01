// Ein Verwalter gibt die Verwaltung selbst ab - die Leitung geht so nicht (siehe leaveTeamAsAdmin).
import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { leaveTeamAsAdmin, requireTeamAccess } from "$lib/server/teams";
import { requireUser } from "$lib/server/guards";

export const DELETE: RequestHandler = ({ locals, params }) => {
	const userId = requireUser(locals);
	requireTeamAccess(locals.db, userId, params.teamId!);
	if (!leaveTeamAsAdmin(locals.db, params.teamId!, userId)) error(404, "Team unbekannt");
	return json({ ok: true });
};
