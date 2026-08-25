// Der Draht zum Server.
//
// Absichtlich dumm: hier steht, WIE gefragt wird, nicht WANN oder WARUM. Das
// Wann steht in engine.ts, das Warum in outbox.ts.
//
// Die Abrufmethode ist austauschbar, weil die beiden Ausfuehrungen sie
// verschieden brauchen: im Browser das eingebaute `fetch`, in der
// Desktop-Anwendung der Weg ueber das http-Plugin. Letzteres geht durch den
// Rust-Teil und umgeht damit die Herkunftspruefung des Browsers - ein Webview
// hat eine Herkunft, die kein Server sinnvoll erlauben kann.
import type { KeyWrap } from "../crypto/vault";

export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

export interface ServerRecord {
	id: string;
	kind: string;
	bucket: string | null;
	seq: number;
	rev: number;
	updatedAt: number;
	deviceId: string | null;
	deletedAt: number | null;
	payload: string | null;
}

export interface OutgoingRecord {
	id: string;
	kind: string;
	bucket?: string | null;
	baseRev: number;
	updatedAt: number;
	deletedAt?: number | null;
	payload?: string | null;
}

export interface PullPage {
	records: ServerRecord[];
	nextSeq: number;
	hasMore: boolean;
}

export interface PushAnswer {
	accepted: { id: string; rev: number; seq: number }[];
	conflicts: { id: string; current: ServerRecord }[];
	seq: number;
}

export interface AccountInfo {
	userId: string;
	displayName: string;
	email: string | null;
	seq: number;
	wrapKinds: string[];
	passkeys: { id: string; hasPrf: boolean; createdAt: number; lastUsedAt: number | null }[];
	devices: { id: string; label: string; lastSeenAt: number | null; revokedAt: number | null }[];
}

/**
 * Ein Fehler vom Server, mit seinem Statuscode.
 *
 * Der Code entscheidet, was der Aufrufer tut: 401 heisst "abgemeldet, hoer auf",
 * 409 heisst "versuch es noch einmal", alles ab 500 heisst "spaeter wieder".
 * Ohne ihn muesste jeder Aufrufer Meldungstexte auswerten.
 */
export class ApiError extends Error {
	constructor(
		message: string,
		readonly status: number
	) {
		super(message);
		this.name = "ApiError";
	}

	/** Lohnt ein spaeterer Versuch? */
	get retryable(): boolean {
		return this.status === 0 || this.status === 429 || this.status >= 500;
	}
}

export interface ApiOptions {
	baseUrl: string;
	/** Das Geraete-Token. Ohne eines laeuft die Anfrage ueber das Sitzungs-Cookie. */
	token?: string | null;
	fetchFn?: FetchFn;
}

export class Api {
	#baseUrl: string;
	#token: string | null;
	#fetch: FetchFn;

	constructor(opts: ApiOptions) {
		// Abschliessende Schraegstriche wegnehmen, sonst entstehen Adressen mit "//".
		this.#baseUrl = opts.baseUrl.replace(/\/+$/, "");
		this.#token = opts.token ?? null;
		this.#fetch = opts.fetchFn ?? ((i, init) => globalThis.fetch(i, init));
	}

	setToken(token: string | null): void {
		this.#token = token;
	}

	async #call<T>(path: string, init: RequestInit = {}): Promise<T> {
		let res: Response;
		try {
			res = await this.#fetch(`${this.#baseUrl}${path}`, {
				...init,
				headers: {
					"content-type": "application/json",
					...(this.#token ? { authorization: `Bearer ${this.#token}` } : {}),
					...(init.headers ?? {})
				},
				// Ohne Token laeuft es ueber das Cookie - das muss ausdruecklich mit.
				credentials: this.#token ? "omit" : "include"
			});
		} catch (e) {
			// Kein Netz, Name nicht aufloesbar, Verbindung abgebrochen. Status 0 heisst
			// "gar nicht erst angekommen" und ist damit immer einen zweiten Versuch wert.
			throw new ApiError(e instanceof Error ? e.message : "Server nicht erreichbar", 0);
		}

		if (!res.ok) {
			// SvelteKit schickt seine Fehler als JSON mit `message`. Ist da etwas
			// anderes, bleibt der Statustext - besser als eine leere Meldung.
			const text = await res.text().catch(() => "");
			let message = res.statusText || `Fehler ${res.status}`;
			try {
				const parsed = JSON.parse(text);
				if (parsed?.message) message = String(parsed.message);
			} catch {
				if (text) message = text.slice(0, 200);
			}
			throw new ApiError(message, res.status);
		}

		return (await res.json()) as T;
	}

	// ---------- Konto ----------

	me(): Promise<AccountInfo> {
		return this.#call<AccountInfo>("/api/me");
	}

	logout(): Promise<{ ok: boolean }> {
		return this.#call("/api/auth/logout", { method: "POST" });
	}

	// ---------- Abgleich ----------

	pull(since: number, opts: { limit?: number; bucket?: string } = {}): Promise<PullPage> {
		const q = new URLSearchParams({ since: String(since) });
		if (opts.limit) q.set("limit", String(opts.limit));
		if (opts.bucket) q.set("bucket", opts.bucket);
		return this.#call<PullPage>(`/api/sync?${q}`);
	}

	push(records: OutgoingRecord[]): Promise<PushAnswer> {
		return this.#call<PushAnswer>("/api/sync", {
			method: "POST",
			body: JSON.stringify({ records })
		});
	}

	// ---------- Schluessel ----------

	wraps(): Promise<{ wraps: { id: string; kind: string; credentialId: string | null; payload: string }[] }> {
		return this.#call("/api/wraps");
	}

	putWrap(kind: KeyWrap["kind"], payload: string, credentialId?: string): Promise<{ id: string }> {
		return this.#call("/api/wraps", {
			method: "POST",
			body: JSON.stringify({ kind, payload, credentialId })
		});
	}

	// ---------- Kopplung ----------

	pairStart(publicKey: string, label: string): Promise<{ code: string; expiresAt: number }> {
		return this.#call("/api/pair/start", {
			method: "POST",
			body: JSON.stringify({ publicKey, label })
		});
	}

	pairLookup(code: string): Promise<{ publicKey: string; label: string }> {
		return this.#call(`/api/pair/approve?code=${encodeURIComponent(code)}`);
	}

	pairApprove(code: string, wrappedKey: string): Promise<{ deviceId: string; label: string }> {
		return this.#call("/api/pair/approve", {
			method: "POST",
			body: JSON.stringify({ code, wrappedKey })
		});
	}

	pairClaim(
		code: string
	): Promise<
		{ pending: true } | { pending: false; userId: string; wrappedKey: string; deviceToken: string }
	> {
		return this.#call("/api/pair/claim", { method: "POST", body: JSON.stringify({ code }) });
	}

	revokeDevice(deviceId: string): Promise<{ ok: boolean }> {
		return this.#call("/api/devices", {
			method: "DELETE",
			body: JSON.stringify({ deviceId })
		});
	}

	/** Die Adresse des Weckruf-Kanals - den oeffnet der Aufrufer selbst. */
	streamUrl(): string {
		return `${this.#baseUrl}/api/sync/stream`;
	}
}
