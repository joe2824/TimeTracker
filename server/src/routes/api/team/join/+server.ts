// Team beitreten - ohne Konto, ohne Anmeldung. Der Code ist der einzige Ausweis.
import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { joinTeam, teamFromInviteCode } from "$lib/server/teams";

/** Vorschau vor dem Beitritt: nur der Teamname, nichts Vertrauliches. */
export const GET: RequestHandler = ({ locals, url }) => {
	const code = String(url.searchParams.get("code") ?? "");
	const team = teamFromInviteCode(locals.db, code);
	if (!team) error(404, "Link unbekannt oder abgelaufen");
	return json({ teamName: team.name });
};

export const POST: RequestHandler = async ({ locals, request }) => {
	const body = await request.json().catch(() => null);
	const code = String(body?.code ?? "");
	const name = String(body?.name ?? "").trim();
	if (!name) error(400, "Name fehlt");
	// Freiwillig - nur für die Erinnerung an Fehlende, sonst nirgends nötig.
	const email = typeof body?.email === "string" ? body.email : undefined;
	const joined = joinTeam(locals.db, code, name, email);
	// Wie bei /api/pair/claim: ein unbekannter/ungültiger Code antwortet wie ein
	// nicht existierender - die Bremse in hooks.server.ts zählt genau das.
	if (!joined) error(404, "Link unbekannt oder abgelaufen");
	return json(joined, { status: 201 });
};
