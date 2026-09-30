// Verwalter-Link annehmen - anders als /api/team/join braucht das ein Konto.
import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { joinTeamAsAdmin, teamFromAdminInviteCode } from "$lib/server/teams";
import { readJson } from "$lib/server/request";
import { requireUser } from "$lib/server/guards";

/** Vorschau vor dem Anmelden: nur der Teamname, nichts Vertrauliches. */
export const GET: RequestHandler = ({ locals, url }) => {
	const code = String(url.searchParams.get("code") ?? "");
	const team = teamFromAdminInviteCode(locals.db, code);
	if (!team) error(404, "Link unbekannt oder abgelaufen");
	return json({ teamName: team.name });
};

export const POST: RequestHandler = async ({ locals, request }) => {
	const userId = requireUser(locals);
	const body = await readJson(request);
	const code = String(body?.code ?? "");
	// Wer den eigenen Link einliest, ist schon Chef - joinTeamAsAdmin legt dann
	// keine Zeile an. 200 statt 201, das waere sonst "erstellt" ohne Erstellung.
	const wasAlreadyOwner = teamFromAdminInviteCode(locals.db, code)?.ownerUserId === userId;
	const team = joinTeamAsAdmin(locals.db, code, userId);
	if (!team) error(404, "Link unbekannt oder abgelaufen");
	return json(team, { status: wasAlreadyOwner ? 200 : 201 });
};
