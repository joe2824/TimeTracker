// Mitgliedsseite: den eigenen Monatsbericht ablegen.
import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { requireTeamMember, upsertTeamReport } from "$lib/server/teams";

export const POST: RequestHandler = async ({ locals, request }) => {
	const teamId = requireTeamMember(locals);
	const body = await request.json().catch(() => null);
	const month = String(body?.month ?? "");
	if (!/^\d{4}-\d{2}$/.test(month)) error(400, "month fehlt oder hat nicht die Form YYYY-MM");
	if (!body?.report || typeof body.report !== "object") error(400, "report fehlt");
	upsertTeamReport(locals.db, teamId, locals.teamMemberId!, month, body.report);
	return json({ ok: true }, { status: 201 });
};
