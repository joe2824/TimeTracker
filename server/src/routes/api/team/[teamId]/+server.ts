// Ein einzelnes Team - nur der Chef selbst (sein normales Konto).
import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { deleteTeam, requireOwnTeam } from "$lib/server/teams";

/** Endgültig löschen - Mitglieder, Aktivitäten und Berichte gehen mit (cascade). */
export const DELETE: RequestHandler = ({ locals, params }) => {
	if (!locals.userId) error(401, "Nicht angemeldet");
	requireOwnTeam(locals.db, locals.userId, params.teamId!);
	deleteTeam(locals.db, params.teamId!);
	return json({ ok: true });
};
