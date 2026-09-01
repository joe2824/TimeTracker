// Telemetrie- und Nutzungsstatistiken abrufen - nur fuer Verwalter.
import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { isAdminUser } from "$lib/server/invites";
import { getTelemetryStats } from "$lib/server/stats";

export const GET: RequestHandler = ({ locals, url }) => {
	if (!locals.userId) error(401, "Nicht angemeldet");
	if (!isAdminUser(locals.db, locals.userId)) error(403, "Keine Berechtigung");

	const daysParam = url.searchParams.get("days");
	const days = daysParam ? Math.min(90, Math.max(1, parseInt(daysParam, 10) || 30)) : 30;

	const stats = getTelemetryStats(locals.db, days);
	return json(stats);
};

