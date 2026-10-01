// Der Einladungslink eines Teams - Leitung und Verwalter sehen/erzeugen ihn.
import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { activeTeamInvite, requireTeamAccess, rotateTeamInvite } from "$lib/server/teams";
import { requireUser } from "$lib/server/guards";

export const GET: RequestHandler = ({ locals, params }) => {
	const userId = requireUser(locals);
	requireTeamAccess(locals.db, userId, params.teamId!);
	return json({ invite: activeTeamInvite(locals.db, params.teamId!) });
};

/** Erzeugt einen neuen Link und widerruft dabei den bisherigen - "Neuen Link erzeugen". */
export const POST: RequestHandler = ({ locals, params }) => {
	const userId = requireUser(locals);
	requireTeamAccess(locals.db, userId, params.teamId!);
	return json(rotateTeamInvite(locals.db, params.teamId!), { status: 201 });
};
