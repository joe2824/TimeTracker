// Der nachgebaute Abgleich-Server fuer die Tests in src/lib/sync.
//
// Er kann genau das, was der Client anfasst: Datensaetze annehmen (mit
// Konflikt), sie nach Stand und Zeitraum wieder herausgeben, die belegten
// Monate nennen und Auskunft ueber das Konto geben. Dazu Zaehlwerk fuer
// Aussagen ueber den Datenverkehr und ein Tor, mit dem ein Test einen
// laufenden Abruf festhalten kann.
import type { ServerRecord } from "../sync/api";

/** Welche Abrufe das Tor anhaelt. */
export type HoldScope =
	/** Jeden. */
	| "all"
	/** Nur die ohne Zeitraum-Filter - die Historie. */
	| "backlog"
	/** Nur den Nachschlag eines einzelnen Monats (Zeitraum, aber ohne "unbucketed"). */
	| "bucket";

interface PushRecord {
	id: string;
	kind: string;
	bucket?: string | null;
	baseRev: number;
	updatedAt: number;
	deletedAt?: number | null;
	payload?: string | null;
}

export class FakeSyncServer {
	rows = new Map<string, ServerRecord>();
	seq = 0;

	/** Jede Anfrage als "METHODE /pfad". */
	calls: string[] = [];
	/** Dasselbe mit Suchteil - fuer Aussagen ueber die Einschraenkung. */
	queries: string[] = [];
	/** Ab welchem Stand jeweils abgerufen wurde. */
	pulledSince: number[] = [];
	/** Wie oft ein Abruf ohne Zeitraum-Filter - also die Historie - anstand. */
	backlogCalls = 0;

	#gate: { scope: HoldScope; blocked: Promise<void>; open: () => void } | null = null;

	/** Passende Abrufe anhalten, bis `release()` kommt. */
	hold(scope: HoldScope = "all"): void {
		let open!: () => void;
		const blocked = new Promise<void>((r) => (open = r));
		this.#gate = { scope, blocked, open };
	}

	release(): void {
		this.#gate?.open();
		this.#gate = null;
	}

	push(deviceId: string, records: unknown[]) {
		const accepted: { id: string; rev: number; seq: number }[] = [];
		const conflicts: { id: string; current: ServerRecord }[] = [];
		for (const raw of records as PushRecord[]) {
			const present = this.rows.get(raw.id);
			const serverRev = present?.rev ?? 0;
			if (serverRev !== raw.baseRev) {
				conflicts.push({
					id: raw.id,
					current: present ?? {
						id: raw.id,
						kind: raw.kind,
						bucket: null,
						seq: 0,
						rev: 0,
						updatedAt: 0,
						deviceId: null,
						deletedAt: null,
						payload: null
					}
				});
				continue;
			}
			this.seq++;
			const rev = serverRev + 1;
			this.rows.set(raw.id, {
				id: raw.id,
				kind: raw.kind,
				bucket: raw.bucket ?? null,
				seq: this.seq,
				rev,
				updatedAt: raw.updatedAt,
				deviceId,
				deletedAt: raw.deletedAt ?? null,
				payload: raw.deletedAt ? null : (raw.payload ?? null)
			});
			accepted.push({ id: raw.id, rev, seq: this.seq });
		}
		return { accepted, conflicts, seq: this.seq };
	}

	pull(since: number, limit = 200, filter?: { buckets?: string[]; unbucketed: boolean }) {
		this.pulledSince.push(since);
		const matches = (r: ServerRecord) => {
			if (!filter?.buckets) return true;
			if (r.bucket === null) return filter.unbucketed;
			return filter.buckets.includes(r.bucket);
		};
		const all = [...this.rows.values()]
			.filter((r) => r.seq > since && matches(r))
			.sort((a, b) => a.seq - b.seq);
		const page = all.slice(0, limit);
		return {
			records: page,
			nextSeq: page.length > 0 ? page[page.length - 1].seq : since,
			hasMore: all.length > limit
		};
	}

	/** Wie viele Datensaetze je Art liegen. */
	kinds(): Record<string, number> {
		const out: Record<string, number> = {};
		for (const r of this.rows.values()) out[r.kind] = (out[r.kind] ?? 0) + 1;
		return out;
	}

	/** Die belegten Monatskennungen - wie GET /api/sync/buckets. */
	buckets(): string[] {
		return [...new Set([...this.rows.values()].map((r) => r.bucket))].filter(
			(b): b is string => b !== null
		);
	}

	/** Eine Abrufmethode, die statt ins Netz in diesen Nachbau greift. */
	fetchFor(deviceId: string) {
		return async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
			const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
			const url = new URL(href, "http://test");
			const method = init?.method ?? "GET";
			this.calls.push(`${method} ${url.pathname}`);
			this.queries.push(`${method} ${url.pathname}${url.search}`);

			if (url.pathname === "/api/sync" && method === "GET") {
				const buckets = url.searchParams.getAll("bucket");
				const unbucketed = url.searchParams.get("unbucketed") === "1";
				if (buckets.length === 0) this.backlogCalls++;
				await this.#waitAtGate(buckets.length > 0, unbucketed);
				return json(
					this.pull(
						Number(url.searchParams.get("since") ?? 0),
						Number(url.searchParams.get("limit") ?? 200),
						{ buckets: buckets.length > 0 ? buckets : undefined, unbucketed }
					)
				);
			}
			if (url.pathname === "/api/sync" && method === "POST") {
				const body = JSON.parse(String(init!.body));
				return json(this.push(deviceId, body.records));
			}
			if (url.pathname === "/api/sync/buckets") {
				return json({ buckets: this.buckets() });
			}
			if (url.pathname === "/api/me") {
				return json({ userId: "u1", displayName: "Ich", isAdmin: false });
			}
			return json({ message: "unbekannt" }, 404);
		};
	}

	async #waitAtGate(filtered: boolean, unbucketed: boolean): Promise<void> {
		const gate = this.#gate;
		if (!gate) return;
		// "bucket" meint den Nachschlag eines einzelnen Monats - die vorgezogene
		// Menge traegt zusaetzlich "unbucketed" und laeuft weiter.
		const hit =
			gate.scope === "all" ||
			(gate.scope === "backlog" && !filtered) ||
			(gate.scope === "bucket" && filtered && !unbucketed);
		if (hit) await gate.blocked;
	}
}

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status });
}
