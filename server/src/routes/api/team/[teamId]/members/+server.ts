// Das Roster eines Teams - Chef und Verwalter sehen/verwalten es.
import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { listTeamMembers, requireTeamAccess, revokeTeamMember } from "$lib/server/teams";

export const GET: RequestHandler = ({ locals, params }) => {
	if (!locals.userId) error(401, "Nicht angemeldet");
	requireTeamAccess(locals.db, locals.userId, params.teamId!);
	return json({ members: listTeamMembers(locals.db, params.teamId!) });
};

/** Ein Mitglied hinauswerfen - sein Token wird sofort ungültig. */
export const DELETE: RequestHandler = async ({ locals, params, request }) => {
	if (!locals.userId) error(401, "Nicht angemeldet");
	requireTeamAccess(locals.db, locals.userId, params.teamId!);
	const body = await request.json().catch(() => null);
	const memberId = String(body?.memberId ?? "");
	if (!revokeTeamMember(locals.db, params.teamId!, memberId)) {
		error(404, "Mitglied unbekannt oder schon entfernt");
	}
	return json({ ok: true });
};
