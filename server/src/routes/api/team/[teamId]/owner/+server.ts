// Besitz übergeben - nur der amtierende Chef, und nur an einen bestehenden
// Verwalter (siehe transferTeamOwnership).
import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { requireOwnTeam, transferTeamOwnership } from "$lib/server/teams";

export const POST: RequestHandler = async ({ locals, params, request }) => {
	if (!locals.userId) error(401, "Nicht angemeldet");
	const team = requireOwnTeam(locals.db, locals.userId, params.teamId!);
	const body = await request.json().catch(() => null);
	const newOwnerUserId = String(body?.newOwnerUserId ?? "");
	if (!newOwnerUserId) error(400, "newOwnerUserId fehlt");
	transferTeamOwnership(locals.db, team, newOwnerUserId);
	return json({ ok: true });
};
