// Der Verwalter-Einladungslink eines Teams - nur der Chef erzeugt ihn, nicht
// delegierbar an einen bestehenden Verwalter (sonst koennte ein Verwalter
// beliebig weitere Verwalter einsetzen).
import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { activeAdminInvite, requireOwnTeam, rotateAdminInvite } from "$lib/server/teams";

export const GET: RequestHandler = ({ locals, params }) => {
	if (!locals.userId) error(401, "Nicht angemeldet");
	requireOwnTeam(locals.db, locals.userId, params.teamId!);
	return json({ invite: activeAdminInvite(locals.db, params.teamId!) });
};

/** Erzeugt einen neuen Link und widerruft dabei den bisherigen. */
export const POST: RequestHandler = ({ locals, params }) => {
	if (!locals.userId) error(401, "Nicht angemeldet");
	requireOwnTeam(locals.db, locals.userId, params.teamId!);
	return json(rotateAdminInvite(locals.db, params.teamId!), { status: 201 });
};
