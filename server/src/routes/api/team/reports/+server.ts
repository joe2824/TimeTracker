// Mitgliedsseite: den eigenen Monatsbericht ablegen und nachsehen, ob er vorliegt.
import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import {
	findTeamReport,
	isPlausibleReportMonth,
	isReportMonthFormat,
	requireTeamMember,
	sanitizeTeamReport,
	upsertTeamReport
} from "$lib/server/teams";
import { readJson } from "$lib/server/request";

/** Ob für den Monat schon ein Bericht dieses Mitglieds vorliegt - auch ein von der Leitung von Hand vermerkter. */
export const GET: RequestHandler = async ({ locals, url }) => {
	requireTeamMember(locals);
	const month = url.searchParams.get("month") ?? "";
	if (!isReportMonthFormat(month)) error(400, "month fehlt oder hat nicht die Form YYYY-MM");
	const found = findTeamReport(locals.db, locals.teamMemberId!, month);
	return json({ submittedAt: found?.submittedAt ?? null });
};

export const POST: RequestHandler = async ({ locals, request }) => {
	const teamId = requireTeamMember(locals);
	const body = await readJson(request);
	const month = String(body?.month ?? "");
	if (!isPlausibleReportMonth(month)) error(400, "month fehlt, hat nicht die Form YYYY-MM oder liegt zu weit weg");
	const report = sanitizeTeamReport(body?.report);
	if (!report) error(400, "report fehlt");
	upsertTeamReport(locals.db, teamId, locals.teamMemberId!, month, report);
	return json({ ok: true }, { status: 201 });
};
