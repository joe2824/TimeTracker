// Mitgliedsseite: den eigenen Monatsbericht ablegen.
import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { isPlausibleReportMonth, requireTeamMember, sanitizeTeamReport, upsertTeamReport } from "$lib/server/teams";

export const POST: RequestHandler = async ({ locals, request }) => {
	const teamId = requireTeamMember(locals);
	const body = await request.json().catch(() => null);
	const month = String(body?.month ?? "");
	if (!isPlausibleReportMonth(month)) error(400, "month fehlt, hat nicht die Form YYYY-MM oder liegt zu weit weg");
	const report = sanitizeTeamReport(body?.report);
	if (!report) error(400, "report fehlt");
	upsertTeamReport(locals.db, teamId, locals.teamMemberId!, month, report);
	return json({ ok: true }, { status: 201 });
};
