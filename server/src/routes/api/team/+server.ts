// Teams anlegen und auflisten - nur der Chef selbst (sein normales Konto).
import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { createTeam, listTeams } from "$lib/server/teams";

export const GET: RequestHandler = ({ locals }) => {
	if (!locals.userId) error(401, "Nicht angemeldet");
	return json({ teams: listTeams(locals.db, locals.userId) });
};

export const POST: RequestHandler = async ({ locals, request }) => {
	if (!locals.userId) error(401, "Nicht angemeldet");
	const body = await request.json().catch(() => null);
	const name = String(body?.name ?? "").trim();
	if (!name) error(400, "Name fehlt");
	const team = createTeam(locals.db, locals.userId, name);
	return json(team, { status: 201 });
};
