// Ein einzelnes Team - nur der Chef selbst (sein normales Konto).
import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { deleteTeam, requireOwnTeam } from "$lib/server/teams";
import { requireUser } from "$lib/server/guards";

/** Endgültig löschen - Mitglieder, Aktivitäten und Berichte gehen mit (cascade). */
export const DELETE: RequestHandler = ({ locals, params }) => {
	const userId = requireUser(locals);
	requireOwnTeam(locals.db, userId, params.teamId!);
	deleteTeam(locals.db, params.teamId!);
	return json({ ok: true });
};
