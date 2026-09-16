// Besitz übergeben - nur der amtierende Chef, und nur an einen bestehenden
// Verwalter (siehe transferTeamOwnership).
import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { requireOwnTeam, transferTeamOwnership } from "$lib/server/teams";

export const POST: RequestHandler = async ({ locals, params, request }) => {
	if (!locals.userId) error(401, "Nicht angemeldet");
	// Erst das await, dann erst der Datenbank-Zugriff: db ist synchron
	// (better-sqlite3), also laeuft ab hier bis zur Antwort nichts anderes
	// dazwischen - sonst koennte ein zweiter, ueberlappender Aufruf mit einem
	// veralteten team.ownerUserId weiterrechnen (transferTeamOwnership setzt
	// darueber den bisherigen Chef als Verwalter wieder ein).
	const body = await request.json().catch(() => null);
	const newOwnerUserId = String(body?.newOwnerUserId ?? "");
	if (!newOwnerUserId) error(400, "newOwnerUserId fehlt");
	const team = requireOwnTeam(locals.db, locals.userId, params.teamId!);
	transferTeamOwnership(locals.db, team, newOwnerUserId);
	return json({ ok: true });
};
