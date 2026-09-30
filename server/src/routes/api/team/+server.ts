// Teams anlegen und auflisten - nur der Chef selbst (sein normales Konto).
import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { createTeam, listTeams } from "$lib/server/teams";
import { readJson } from "$lib/server/request";
import { requireUser } from "$lib/server/guards";
import { readLabel, TEAM_TEXT_MAX } from "$shared/labels";

export const GET: RequestHandler = ({ locals }) => {
	const userId = requireUser(locals);
	return json({ teams: listTeams(locals.db, userId) });
};

export const POST: RequestHandler = async ({ locals, request }) => {
	const userId = requireUser(locals);
	const body = await readJson(request);
	const name = readLabel(body?.name, "", TEAM_TEXT_MAX);
	if (!name) error(400, "Name fehlt");
	const team = createTeam(locals.db, userId, name);
	return json(team, { status: 201 });
};
