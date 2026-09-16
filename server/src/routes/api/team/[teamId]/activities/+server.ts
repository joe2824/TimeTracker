// Die gemeinsame Aktivitätenliste eines Teams - Chef und Verwalter ändern sie.
import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { listTeamActivities, requireTeamAccess, setTeamActivities, type TeamActivityInput } from "$lib/server/teams";

export const GET: RequestHandler = ({ locals, params }) => {
	if (!locals.userId) error(401, "Nicht angemeldet");
	requireTeamAccess(locals.db, locals.userId, params.teamId!);
	return json({ activities: listTeamActivities(locals.db, params.teamId!) });
};

export const PUT: RequestHandler = async ({ locals, params, request }) => {
	if (!locals.userId) error(401, "Nicht angemeldet");
	requireTeamAccess(locals.db, locals.userId, params.teamId!);
	const body = await request.json().catch(() => null);
	if (!Array.isArray(body?.activities)) error(400, "activities fehlt");
	const items: TeamActivityInput[] = body.activities.map((a: Record<string, unknown>, i: number) => ({
		id: typeof a?.id === "string" ? a.id : undefined,
		name: String(a?.name ?? "").trim(),
		isAbsence: Boolean(a?.isAbsence),
		sortOrder: Number.isFinite(a?.sortOrder) ? Number(a.sortOrder) : i,
		color: typeof a?.color === "string" ? a.color : null,
		archived: Boolean(a?.archived)
	}));
	if (items.some((it) => !it.name)) error(400, "Aktivität ohne Namen");
	const expectedVersion = typeof body?.expectedVersion === "number" ? body.expectedVersion : undefined;
	return json({ activities: setTeamActivities(locals.db, params.teamId!, items, expectedVersion) });
};
