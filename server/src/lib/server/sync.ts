// Abholen und Ablegen versiegelter Datensätze.
import type { PullPage, PushAnswer, PushConflict, PushRecord, ServerRecord } from "$shared/apiTypes";
export type { PullPage, PushAnswer, PushRecord, ServerRecord };
import { and, asc, eq, gt, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import type { Db } from "./db/index";
import { records, users } from "./db/schema";
import {
	DEFAULT_PAGE,
	MAX_BUCKETS,
	MAX_PAGE,
	MAX_RECORD_BYTES,
	MAX_RECORDS_PER_USER
} from "./config";

export class SyncError extends Error {
	constructor(
		message: string,
		readonly status: number
	) {
		super(message);
	}
}

const toStored = (r: typeof records.$inferSelect): ServerRecord => ({
	id: r.id,
	kind: r.kind,
	bucket: r.bucket,
	seq: r.seq,
	rev: r.rev,
	updatedAt: r.updatedAt,
	deviceId: r.deviceId,
	deletedAt: r.deletedAt,
	payload: r.payload
});

export interface PullOptions {
	since?: number;
	limit?: number;
	/** Nur diese Buckets. Fehlt die Angabe, gilt keine Einschränkung. */
	buckets?: string[];
	/** Aktivitäten und Einstellungen (bucket IS NULL) mitnehmen. */
	includeUnbucketed?: boolean;
}

/** Alles, was seit `since` dazugekommen ist - seitenweise. */
export function pullRecords(db: Db, userId: string, opts: PullOptions = {}): PullPage {
	const limit = Math.min(Math.max(1, opts.limit ?? DEFAULT_PAGE), MAX_PAGE);
	const since = Math.max(0, opts.since ?? 0);

	const buckets = opts.buckets ? [...new Set(opts.buckets)] : undefined;
	if (buckets && buckets.length > MAX_BUCKETS) {
		throw new SyncError(`Höchstens ${MAX_BUCKETS} Buckets je Anfrage`, 400);
	}

	// Erst eine Bucket-Liste schränkt ein. `includeUnbucketed` allein sagt nur,
	// dass die Datensätze ohne Bucket dazugehören.
	const scoped = buckets !== undefined;
	const scope = [
		...(buckets?.length ? [inArray(records.bucket, buckets)] : []),
		...(opts.includeUnbucketed ? [isNull(records.bucket)] : [])
	];
	// Eingeschränkt, aber auf nichts: das ist eine leere Antwort, kein voller
	// Durchlauf. Ohne diesen Zweig lieferte `or()` von nichts alle Datensätze.
	if (scoped && scope.length === 0) {
		return { records: [], nextSeq: since, hasMore: false };
	}

	const where = scope.length
		? and(eq(records.userId, userId), gt(records.seq, since), or(...scope))
		: and(eq(records.userId, userId), gt(records.seq, since));

	// Eine Zeile mehr holen, als ausgeliefert wird: daran - und nur daran - lässt
	// sich "es gibt noch mehr" erkennen, ohne ein zweites COUNT über die Tabelle.
	const rows = db
		.select()
		.from(records)
		.where(where)
		.orderBy(asc(records.seq))
		.limit(limit + 1)
		.all();

	const hasMore = rows.length > limit;
	const page = hasMore ? rows.slice(0, limit) : rows;
	return {
		records: page.map(toStored),
		nextSeq: page.length > 0 ? page[page.length - 1].seq : since,
		hasMore
	};
}

/**
 * Welche Buckets dieses Konto überhaupt hat.
 *
 * Der Client rechnet daraus zurück, zu welchen Monaten Daten vorliegen - auch
 * zu denen, die er noch nicht heruntergeladen hat. Der Server erfährt dabei
 * nichts Neues: die Hashes stehen ohnehin in seiner Tabelle.
 */
export function listBuckets(db: Db, userId: string): string[] {
	return db
		.selectDistinct({ bucket: records.bucket })
		.from(records)
		.where(and(eq(records.userId, userId), isNotNull(records.bucket)))
		.all()
		.map((r) => r.bucket as string);
}

/** Obergrenzen für die Kennungen eines Datensatzes - weit über dem, was der Client erzeugt. */
const MAX_ID_LENGTH = 256;
const MAX_KIND_LENGTH = 64;
const MAX_BUCKET_LENGTH = 128;

const isText = (v: unknown, max: number): v is string =>
	typeof v === "string" && v.length > 0 && v.length <= max;
const isOptional = (v: unknown, check: (v: unknown) => boolean): boolean =>
	v === undefined || v === null || check(v);
const isTimestamp = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/**
 * Form eines eingehenden Datensatzes prüfen - vor der Transaktion. Was hier
 * durchrutscht, scheitert sonst erst an SQLite oder an `.length` und kommt als
 * 500 zurück statt als verständliche Ablehnung.
 */
function validateIncoming(raw: unknown): asserts raw is PushRecord {
	if (!raw || typeof raw !== "object") throw new SyncError("Datensatz ist kein Objekt", 400);
	const r = raw as Record<string, unknown>;
	if (!isText(r.id, MAX_ID_LENGTH) || !isText(r.kind, MAX_KIND_LENGTH)) {
		throw new SyncError("Datensatz ohne gültige id oder kind", 400);
	}
	if (!isOptional(r.bucket, (v) => typeof v === "string" && v.length <= MAX_BUCKET_LENGTH)) {
		throw new SyncError(`Datensatz ${r.id}: ungültiger Bucket`, 400);
	}
	if (!isTimestamp(r.updatedAt) || !isOptional(r.deletedAt, isTimestamp)) {
		throw new SyncError(`Datensatz ${r.id}: ungültiger Zeitstempel`, 400);
	}
	if (!Number.isSafeInteger(r.baseRev) || (r.baseRev as number) < 0) {
		throw new SyncError(`Datensatz ${r.id}: ungültige Fassung`, 400);
	}
	if (!isOptional(r.payload, (v) => typeof v === "string")) {
		throw new SyncError(`Datensatz ${r.id}: ungültiger Inhalt`, 400);
	}
	if (typeof r.payload === "string" && r.payload.length > MAX_RECORD_BYTES) {
		throw new SyncError(`Datensatz ${r.id} ist zu gross`, 413);
	}
}

/** Geänderte Datensätze ablegen. */
export function pushRecords(
	db: Db,
	userId: string,
	deviceId: string | null,
	incoming: PushRecord[]
): PushAnswer {
	for (const r of incoming) validateIncoming(r);

	// Alles in einer Transaktion: ein halb geschriebener Stapel hinterliesse Lücken in
	// der seq-Reihenfolge, und wer genau dazwischen abholt, hält den Rest für gesehen.
	return db.transaction((tx) => {
		const user = tx.select().from(users).where(eq(users.id, userId)).get();
		if (!user) throw new SyncError("Konto nicht gefunden", 404);

		const accepted: PushAnswer["accepted"] = [];
		const conflicts: PushConflict[] = [];
		let seq = user.seqCounter;

		const existingRow = tx
			.select({ n: sql<number>`count(*)` })
			.from(records)
			.where(eq(records.userId, userId))
			.get();
		let count = existingRow?.n ?? 0;

		for (const r of incoming) {
			const existing = tx
				.select()
				.from(records)
				.where(and(eq(records.userId, userId), eq(records.id, r.id)))
				.get();

			// Die Fassung muss genau die sein, die das Gerät zuletzt gesehen hat.
			// Sonst hat inzwischen ein anderes geschrieben - der Client führt
			// zusammen und versucht es erneut.
			const serverRev = existing?.rev ?? 0;
			if (serverRev !== r.baseRev) {
				if (existing) conflicts.push({ id: r.id, current: toStored(existing) });
				else conflicts.push({ id: r.id, current: emptyState(r) });
				continue;
			}

			if (!existing) {
				if (count >= MAX_RECORDS_PER_USER) {
					throw new SyncError("Das Konto hat sein Datensatz-Limit erreicht", 507);
				}
				count++;
			}

			seq++;
			const rev = serverRev + 1;
			const rowText = {
				userId,
				id: r.id,
				kind: r.kind,
				bucket: r.bucket ?? null,
				seq,
				rev,
				updatedAt: r.updatedAt,
				deviceId,
				deletedAt: r.deletedAt ?? null,
				// Bei einer Löschung fällt das Chiffrat weg. Was bleibt, ist der
				// Löschmarker: ohne ihn hält ein Gerät, das die Löschung verpasst hat,
				// seinen alten Stand für gültig und lädt ihn wieder hoch.
				payload: r.deletedAt ? null : (r.payload ?? null)
			};

			if (existing) {
				tx.update(records)
					.set(rowText)
					.where(and(eq(records.userId, userId), eq(records.id, r.id)))
					.run();
			} else {
				tx.insert(records).values(rowText).run();
			}
			accepted.push({ id: r.id, rev, seq });
		}

		if (seq !== user.seqCounter) {
			tx.update(users).set({ seqCounter: seq }).where(eq(users.id, userId)).run();
		}
		return { accepted, conflicts, seq };
	});
}

/** Der "Stand" eines Datensatzes, den es auf dem Server gar nicht gibt. */
function emptyState(r: PushRecord): ServerRecord {
	return {
		id: r.id,
		kind: r.kind,
		bucket: r.bucket ?? null,
		seq: 0,
		rev: 0,
		updatedAt: 0,
		deviceId: null,
		deletedAt: null,
		payload: null
	};
}

/** Der aktuelle Stand eines Kontos - was ein Gerät zum Aufsetzen braucht. */
export function currentSeq(db: Db, userId: string): number {
	return db.select().from(users).where(eq(users.id, userId)).get()?.seqCounter ?? 0;
}
