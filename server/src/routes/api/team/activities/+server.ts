// Mitgliedsseite: die eigene Team-Aktivitätenliste abrufen. Auf Zuruf, kein Push.
import type { RequestHandler } from "./$types";
import { json } from "@sveltejs/kit";
import { listTeamActivities, requireTeamMember } from "$lib/server/teams";

export const GET: RequestHandler = ({ locals }) => {
	const teamId = requireTeamMember(locals);
	return json({ activities: listTeamActivities(locals.db, teamId) });
};
