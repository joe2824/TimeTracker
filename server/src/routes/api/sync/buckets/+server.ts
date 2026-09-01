// GET /api/sync/buckets -> welche Buckets dieses Konto hat.
//
// Damit sieht ein Geraet, zu welchen Monaten es Daten gibt, bevor es sie
// heruntergeladen hat.
import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { listBuckets } from "$lib/server/sync";

export const GET: RequestHandler = ({ locals }) => {
	if (!locals.userId) error(401, "Nicht angemeldet");
	return json({ buckets: listBuckets(locals.db, locals.userId) });
};
