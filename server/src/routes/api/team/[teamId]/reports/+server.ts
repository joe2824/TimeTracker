// Wer wann seinen Bericht gesendet hat - nur der Chef sieht das, samt Inhalt.
import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { listTeamReports, requireOwnTeam } from "$lib/server/teams";

export const GET: RequestHandler = ({ locals, params, url }) => {
	if (!locals.userId) error(401, "Nicht angemeldet");
	requireOwnTeam(locals.db, locals.userId, params.teamId!);
	const month = String(url.searchParams.get("month") ?? "");
	if (!/^\d{4}-\d{2}$/.test(month)) error(400, "month fehlt oder hat nicht die Form YYYY-MM");
	return json({ reports: listTeamReports(locals.db, params.teamId!, month) });
};
