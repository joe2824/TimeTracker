// GET /api/sync/buckets -> welche Buckets dieses Konto hat.
//
// Damit sieht ein Gerät, zu welchen Monaten es Daten gibt, bevor es sie
// heruntergeladen hat.
import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { listBuckets } from "$lib/server/sync";
import { requireUser } from "$lib/server/guards";

export const GET: RequestHandler = ({ locals }) => {
	const userId = requireUser(locals);
	return json({ buckets: listBuckets(locals.db, userId) });
};
