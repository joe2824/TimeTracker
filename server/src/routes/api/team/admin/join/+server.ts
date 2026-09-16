// Verwalter-Link annehmen - anders als /api/team/join braucht das ein Konto.
import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { joinTeamAsAdmin, teamFromAdminInviteCode } from "$lib/server/teams";

/** Vorschau vor dem Anmelden: nur der Teamname, nichts Vertrauliches. */
export const GET: RequestHandler = ({ locals, url }) => {
	const code = String(url.searchParams.get("code") ?? "");
	const team = teamFromAdminInviteCode(locals.db, code);
	if (!team) error(404, "Link unbekannt oder abgelaufen");
	return json({ teamName: team.name });
};

export const POST: RequestHandler = async ({ locals, request }) => {
	if (!locals.userId) error(401, "Nicht angemeldet");
	const body = await request.json().catch(() => null);
	const code = String(body?.code ?? "");
	const team = joinTeamAsAdmin(locals.db, code, locals.userId);
	if (!team) error(404, "Link unbekannt oder abgelaufen");
	return json(team, { status: 201 });
};
