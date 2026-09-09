// Der Einladungslink eines Teams - nur der Chef sieht/erzeugt ihn.
import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { activeTeamInvite, requireOwnTeam, rotateTeamInvite } from "$lib/server/teams";

export const GET: RequestHandler = ({ locals, params }) => {
	if (!locals.userId) error(401, "Nicht angemeldet");
	requireOwnTeam(locals.db, locals.userId, params.teamId!);
	return json({ invite: activeTeamInvite(locals.db, params.teamId!) });
};

/** Erzeugt einen neuen Link und widerruft dabei den bisherigen - "Neuen Link erzeugen". */
export const POST: RequestHandler = ({ locals, params }) => {
	if (!locals.userId) error(401, "Nicht angemeldet");
	requireOwnTeam(locals.db, locals.userId, params.teamId!);
	return json(rotateTeamInvite(locals.db, params.teamId!), { status: 201 });
};
