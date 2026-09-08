// Telemetrie- und Nutzungsstatistiken abrufen - nur für Verwalter.
import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { isAdminUser } from "$lib/server/invites";
import { getTelemetryStats } from "$lib/server/stats";
import { countUsers } from "$lib/server/account";

export const GET: RequestHandler = ({ locals, url }) => {
	if (!locals.userId) error(401, "Nicht angemeldet");
	if (!isAdminUser(locals.db, locals.userId)) error(403, "Keine Berechtigung");

	const daysParam = url.searchParams.get("days");
	const days = daysParam ? Math.min(90, Math.max(1, parseInt(daysParam, 10) || 30)) : 30;

	// Die Zahl der Konten gehört nicht zur Telemetrie (die zählt anonyme
	// Geräte) - sie kommt aber im selben Zug, damit die Ansicht dafür keine
	// zweite Anfrage braucht.
	const stats = getTelemetryStats(locals.db, days);
	return json({ ...stats, users: countUsers(locals.db) });
};

