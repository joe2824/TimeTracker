// Der Verwalter-Einladungslink eines Teams - nur die Leitung erzeugt ihn, nicht
// delegierbar an einen bestehenden Verwalter (sonst koennte ein Verwalter
// beliebig weitere Verwalter einsetzen).
import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { activeAdminInvite, requireOwnTeam, rotateAdminInvite } from "$lib/server/teams";
import { requireUser } from "$lib/server/guards";

export const GET: RequestHandler = ({ locals, params }) => {
	const userId = requireUser(locals);
	requireOwnTeam(locals.db, userId, params.teamId!);
	return json({ invite: activeAdminInvite(locals.db, params.teamId!) });
};

/** Erzeugt einen neuen Link und widerruft dabei den bisherigen. */
export const POST: RequestHandler = ({ locals, params }) => {
	const userId = requireUser(locals);
	requireOwnTeam(locals.db, userId, params.teamId!);
	return json(rotateAdminInvite(locals.db, params.teamId!), { status: 201 });
};
