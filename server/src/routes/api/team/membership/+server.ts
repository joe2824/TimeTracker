// Mitgliedsseite: selbst austreten. Ohne das bliebe ein ausgetretenes Mitglied
// beim Chef jeden Monat als "kein Bericht" stehen, bis er es von Hand entfernt.
import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { requireTeamMember, revokeTeamMember } from "$lib/server/teams";

export const DELETE: RequestHandler = ({ locals }) => {
	const teamId = requireTeamMember(locals);
	revokeTeamMember(locals.db, teamId, locals.teamMemberId!);
	return json({ ok: true });
};
