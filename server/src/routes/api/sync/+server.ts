// Der Abgleich: abholen und ablegen.
//
// GET  /api/sync?since=N&limit=M[&bucket=X&bucket=Y][&unbucketed=1]
//                                             -> was seit N dazukam
// POST /api/sync                              -> geänderte Datensätze ablegen
import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { pullRecords, pushRecords, type PushRecord } from "$lib/server/sync";
import { publish } from "$lib/server/events";
import { MAX_BATCH } from "$lib/server/config";
import { readJson, rethrowSyncError } from "$lib/server/request";
import { requireUser } from "$lib/server/guards";

export const GET: RequestHandler = ({ locals, url }) => {
	const userId = requireUser(locals);

	const since = Number(url.searchParams.get("since") ?? 0);
	const limitRaw = url.searchParams.get("limit");
	if (!Number.isFinite(since) || since < 0) error(400, "Ungültiger Stand");

	// Mehrfach angebbar: ?bucket=a&bucket=b. Ohne jede Angabe bleibt es beim
	// vollen Durchlauf, damit ältere Geräte unverändert weiterlaufen.
	const buckets = url.searchParams.getAll("bucket").filter(Boolean);
	const unbucketed = /^(1|true)$/i.test(url.searchParams.get("unbucketed") ?? "");

	try {
		const result = pullRecords(locals.db, userId, {
			since,
			limit: limitRaw ? Number(limitRaw) : undefined,
			buckets: url.searchParams.has("bucket") ? buckets : undefined,
			includeUnbucketed: unbucketed
		});
		return json(result);
	} catch (e) {
		rethrowSyncError(e);
	}
};

export const POST: RequestHandler = async ({ locals, request }) => {
	const userId = requireUser(locals);

	const body = await readJson(request);
	const incoming = body?.records;
	if (!Array.isArray(incoming)) error(400, "records fehlt");
	// Die Grenze ist nicht Schikane: ein unbegrenzter Stapel liefe in einer
	// einzigen Transaktion und hielte währenddessen den Schreibzugriff.
	if (incoming.length > MAX_BATCH) error(413, `Höchstens ${MAX_BATCH} Datensätze je Anfrage`);

	try {
		const result = pushRecords(
			locals.db,
			userId,
			locals.deviceId,
			incoming as PushRecord[]
		);
		// Nur wecken, wenn wirklich etwas dazukam - sonst laden alle anderen
		// Geräte auf einen abgelehnten Stapel hin sinnlos neu.
		if (result.accepted.length > 0) {
			publish(userId, { seq: result.seq, deviceId: locals.deviceId });
		}
		return json(result);
	} catch (e) {
		rethrowSyncError(e);
	}
};
