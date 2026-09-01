// Abholen und Ablegen versiegelter Datensaetze.
import { and, asc, eq, gt, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import type { Db } from "./db";
import { records, users } from "./db/schema";
import {
	DEFAULT_PAGE,
	MAX_BUCKETS,
	MAX_PAGE,
	MAX_RECORD_BYTES,
	MAX_RECORDS_PER_USER
} from "./config";

/** Ein Datensatz, wie ihn der Server ausliefert. */
export interface StoredRecord {
	id: string;
	kind: string;
	bucket: string | null;
	seq: number;
	rev: number;
	updatedAt: number;
	deviceId: string | null;
	deletedAt: number | null;
	/** Chiffrat, base64. Null bei einer Loeschung. */
	payload: string | null;
}

/** Ein Datensatz, wie ihn ein Geraet ablegen will. */
export interface IncomingRecord {
	id: string;
	kind: string;
	bucket?: string | null;
	/** Die Fassung, die dieses Geraet zuletzt gesehen hat. 0 = "gibt es noch nicht". */
	baseRev: number;
	updatedAt: number;
	deletedAt?: number | null;
	payload?: string | null;
}

export interface PullResult {
	records: StoredRecord[];
	/** Der Stand, ab dem beim naechsten Mal weitergelesen wird. */
	nextSeq: number;
	/** Ob noch mehr da ist - der Aufrufer holt dann die naechste Seite. */
	hasMore: boolean;
}

export interface PushConflict {
	id: string;
	/** Was auf dem Server steht. Der Client fuehrt zusammen und schickt erneut. */
	current: StoredRecord;
}

export interface PushResult {
	/** Ids, die uebernommen wurden - mit ihrer neuen Fassung. */
	accepted: { id: string; rev: number; seq: number }[];
	conflicts: PushConflict[];
	/** Der hoechste vergebene Stand; damit weckt der Ereigniskanal die anderen. */
	seq: number;
}

export class SyncError extends Error {
	constructor(
		message: string,
		readonly status: number
	) {
		super(message);
	}
}

const toStored = (r: typeof records.$inferSelect): StoredRecord => ({
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
	/** Nur diese Buckets. Fehlt die Angabe, gilt keine Einschraenkung. */
	buckets?: string[];
	/** Aktivitaeten und Einstellungen (bucket IS NULL) mitnehmen. */
	includeUnbucketed?: boolean;
}

/** Alles, was seit `since` dazugekommen ist - seitenweise. */
export function pullRecords(db: Db, userId: string, opts: PullOptions = {}): PullResult {
	const limit = Math.min(Math.max(1, opts.limit ?? DEFAULT_PAGE), MAX_PAGE);
	const since = Math.max(0, opts.since ?? 0);

	const buckets = opts.buckets ? [...new Set(opts.buckets)] : undefined;
	if (buckets && buckets.length > MAX_BUCKETS) {
		throw new SyncError(`Höchstens ${MAX_BUCKETS} Buckets je Anfrage`, 400);
	}

	// Erst eine Bucket-Liste schraenkt ein. `includeUnbucketed` allein sagt nur,
	// dass die Datensaetze ohne Bucket dazugehoeren.
	const scoped = buckets !== undefined;
	const scope = [
		...(buckets?.length ? [inArray(records.bucket, buckets)] : []),
		...(opts.includeUnbucketed ? [isNull(records.bucket)] : [])
	];
	// Eingeschraenkt, aber auf nichts: das ist eine leere Antwort, kein voller
	// Durchlauf. Ohne diesen Zweig lieferte `or()` von nichts alle Datensaetze.
	if (scoped && scope.length === 0) {
		return { records: [], nextSeq: since, hasMore: false };
	}

	const where = scope.length
		? and(eq(records.userId, userId), gt(records.seq, since), or(...scope))
		: and(eq(records.userId, userId), gt(records.seq, since));

	// Eine Zeile mehr holen, als ausgeliefert wird: daran - und nur daran - laesst
	// sich "es gibt noch mehr" erkennen, ohne ein zweites COUNT ueber die Tabelle.
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
 * Welche Buckets dieses Konto ueberhaupt hat.
 *
 * Der Client rechnet daraus zurueck, zu welchen Monaten Daten vorliegen - auch
 * zu denen, die er noch nicht heruntergeladen hat. Der Server erfaehrt dabei
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

/** Geaenderte Datensaetze ablegen. */
export function pushRecords(
	db: Db,
	userId: string,
	deviceId: string | null,
	incoming: IncomingRecord[]
): PushResult {
	for (const r of incoming) {
		if (r.payload && r.payload.length > MAX_RECORD_BYTES) {
			throw new SyncError(`Datensatz ${r.id} ist zu gross`, 413);
		}
		if (!r.id || !r.kind) throw new SyncError("Datensatz ohne id oder kind", 400);
	}

	// Alles in einer Transaktion: ein halb geschriebener Stapel hinterliesse Luecken in
	// der seq-Reihenfolge, und wer genau dazwischen abholt, haelt den Rest fuer gesehen.
	return db.transaction((tx) => {
		const user = tx.select().from(users).where(eq(users.id, userId)).get();
		if (!user) throw new SyncError("Konto nicht gefunden", 404);

		const accepted: PushResult["accepted"] = [];
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

			// Die Fassung muss genau die sein, die das Geraet zuletzt gesehen hat.
			// Sonst hat inzwischen ein anderes geschrieben - der Client fuehrt
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
				// Bei einer Loeschung faellt das Chiffrat weg. Was bleibt, ist der
				// Loeschmarker: ohne ihn haelt ein Geraet, das die Loeschung verpasst hat,
				// seinen alten Stand fuer gueltig und laedt ihn wieder hoch.
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
function emptyState(r: IncomingRecord): StoredRecord {
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

/** Der aktuelle Stand eines Kontos - was ein Geraet zum Aufsetzen braucht. */
export function currentSeq(db: Db, userId: string): number {
	return db.select().from(users).where(eq(users.id, userId)).get()?.seqCounter ?? 0;
}
