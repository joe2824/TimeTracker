// Wer wann seinen Bericht gesendet hat - nur der Chef sieht das, samt Inhalt.
import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { listTeamReports, requireOwnTeam, setTeamReportStatus } from "$lib/server/teams";

export const GET: RequestHandler = ({ locals, params, url }) => {
	if (!locals.userId) error(401, "Nicht angemeldet");
	requireOwnTeam(locals.db, locals.userId, params.teamId!);
	const month = String(url.searchParams.get("month") ?? "");
	if (!/^\d{4}-\d{2}$/.test(month)) error(400, "month fehlt oder hat nicht die Form YYYY-MM");
	return json({ reports: listTeamReports(locals.db, params.teamId!, month) });
};

/** Von Hand als gesendet markieren - für Berichte, die nicht über die App kamen. */
export const POST: RequestHandler = async ({ locals, params, request }) => {
	if (!locals.userId) error(401, "Nicht angemeldet");
	requireOwnTeam(locals.db, locals.userId, params.teamId!);
	const body = await request.json().catch(() => null);
	const memberId = String(body?.memberId ?? "");
	const month = String(body?.month ?? "");
	if (!/^\d{4}-\d{2}$/.test(month)) error(400, "month fehlt oder hat nicht die Form YYYY-MM");
	if (!setTeamReportStatus(locals.db, params.teamId!, memberId, month, true)) {
		error(404, "Mitglied unbekannt");
	}
	return json({ ok: true }, { status: 201 });
};

/** Eine von Hand gesetzte (oder echte) Markierung zurücknehmen - wieder "kein Bericht". */
export const DELETE: RequestHandler = async ({ locals, params, request }) => {
	if (!locals.userId) error(401, "Nicht angemeldet");
	requireOwnTeam(locals.db, locals.userId, params.teamId!);
	const body = await request.json().catch(() => null);
	const memberId = String(body?.memberId ?? "");
	const month = String(body?.month ?? "");
	if (!/^\d{4}-\d{2}$/.test(month)) error(400, "month fehlt oder hat nicht die Form YYYY-MM");
	if (!setTeamReportStatus(locals.db, params.teamId!, memberId, month, false)) {
		error(404, "Mitglied unbekannt");
	}
	return json({ ok: true });
};
