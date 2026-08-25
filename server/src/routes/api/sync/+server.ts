// Der Abgleich: abholen und ablegen.
//
// GET  /api/sync?since=N&limit=M[&bucket=X]  -> was seit N dazukam
// POST /api/sync                              -> geaenderte Datensaetze ablegen
import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { pullRecords, pushRecords, SyncError, type IncomingRecord } from "$lib/server/sync";
import { publish } from "$lib/server/events";
import { MAX_BATCH } from "$lib/server/config";

export const GET: RequestHandler = ({ locals, url }) => {
	if (!locals.userId) error(401, "Nicht angemeldet");

	const since = Number(url.searchParams.get("since") ?? 0);
	const limitRaw = url.searchParams.get("limit");
	const bucket = url.searchParams.get("bucket") ?? undefined;
	if (!Number.isFinite(since) || since < 0) error(400, "Ungültiger Stand");

	const result = pullRecords(locals.db, locals.userId, {
		since,
		limit: limitRaw ? Number(limitRaw) : undefined,
		bucket
	});
	return json(result);
};

export const POST: RequestHandler = async ({ locals, request }) => {
	if (!locals.userId) error(401, "Nicht angemeldet");

	const body = await request.json().catch(() => null);
	const incoming = body?.records;
	if (!Array.isArray(incoming)) error(400, "records fehlt");
	// Die Grenze ist nicht Schikane: ein unbegrenzter Stapel liefe in einer
	// einzigen Transaktion und hielte waehrenddessen den Schreibzugriff.
	if (incoming.length > MAX_BATCH) error(413, `Höchstens ${MAX_BATCH} Datensätze je Anfrage`);

	try {
		const result = pushRecords(
			locals.db,
			locals.userId,
			locals.deviceId,
			incoming as IncomingRecord[]
		);
		// Nur wecken, wenn wirklich etwas dazukam - sonst laden alle anderen
		// Geraete auf einen abgelehnten Stapel hin sinnlos neu.
		if (result.accepted.length > 0) {
			publish(locals.userId, { seq: result.seq, deviceId: locals.deviceId });
		}
		return json(result);
	} catch (e) {
		if (e instanceof SyncError) error(e.status, e.message);
		throw e;
	}
};
