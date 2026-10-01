// Das Roster eines Teams - Leitung und Verwalter sehen/verwalten es.
import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { listTeamMembers, requireTeamAccess, revokeTeamMember } from "$lib/server/teams";
import { readJson } from "$lib/server/request";
import { requireUser } from "$lib/server/guards";

export const GET: RequestHandler = ({ locals, params }) => {
	const userId = requireUser(locals);
	requireTeamAccess(locals.db, userId, params.teamId!);
	return json({ members: listTeamMembers(locals.db, params.teamId!) });
};

/** Ein Mitglied hinauswerfen - sein Token wird sofort ungültig. */
export const DELETE: RequestHandler = async ({ locals, params, request }) => {
	const userId = requireUser(locals);
	requireTeamAccess(locals.db, userId, params.teamId!);
	const body = await readJson(request);
	const memberId = String(body?.memberId ?? "");
	if (!revokeTeamMember(locals.db, params.teamId!, memberId)) {
		error(404, "Mitglied unbekannt oder schon entfernt");
	}
	return json({ ok: true });
};
