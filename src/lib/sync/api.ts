// Der Draht zum Server.
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

export interface BackupInfo {
	name: string;
	size: number;
	mtime: number;
	verified: boolean;
}

export interface Passkey {
	id: string;
	/** Wie der Mensch ihn nennt. Null, solange niemand ihn benannt hat. */
	label: string | null;
	/** Ob er den Tresor allein oeffnen kann - sonst braucht es Phrase oder Gerät. */
	hasPrf: boolean;
	createdAt: number;
	lastUsedAt: number | null;
}

export interface Invite {
	code: string;
	createdAt: number;
	note: string | null;
	expiresAt: number | null;
	usedAt: number | null;
	usedBy: string | null;
	revokedAt: number | null;
}

export interface AccountInfo {
	userId: string;
	displayName: string;
	email: string | null;
	/** Darf Einladungen vergeben - mehr nicht. */
	isAdmin: boolean;
	seq: number;
	wrapKinds: string[];
	passkeys: Passkey[];
	devices: { id: string; label: string; lastSeenAt: number | null; revokedAt: number | null }[];
}

/** Was beim Aufloesen eines Kontos vom Server verschwunden ist. */
export interface DeleteSummary {
	ok: boolean;
	records: number;
	devices: number;
	passkeys: number;
	wraps: number;
}

/** Ein Fehler vom Server, mit seinem Statuscode. */
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

	updateMe(data: { displayName?: string }): Promise<{ ok: boolean; displayName: string }> {
		return this.#call<{ ok: boolean; displayName: string }>("/api/me", {
			method: "PATCH",
			body: JSON.stringify(data)
		});
	}

	logout(): Promise<{ ok: boolean }> {
		return this.#call("/api/auth/logout", { method: "POST" });
	}

	// ---------- Registrierung und Anmeldung ----------
	//
	// Nur im Browser gebraucht: Passkeys sind an die Domain gebunden, und die
	// Desktop-Anwendung hat keine. Sie koppelt sich stattdessen.

	registerStart(
		displayName: string,
		invite?: string
	): Promise<{ challengeId: string; userId: string; options: unknown }> {
		return this.#call("/api/auth/register/start", {
			method: "POST",
			body: JSON.stringify({ displayName, invite })
		});
	}

	registerFinish(body: {
		challengeId: string;
		displayName: string;
		invite?: string;
		email?: string;
		hasPrf: boolean;
		response: unknown;
	}): Promise<{ userId: string; displayName: string }> {
		return this.#call("/api/auth/register/finish", {
			method: "POST",
			body: JSON.stringify(body)
		});
	}

	/** Ein Konto von diesem Geraet aus anlegen - ohne Passkey. */
	registerDevice(body: {
		displayName: string;
		label: string;
		invite?: string;
		email?: string;
	}): Promise<{ userId: string; displayName: string; deviceId: string; deviceToken: string }> {
		return this.#call("/api/auth/device", { method: "POST", body: JSON.stringify(body) });
	}

	loginStart(): Promise<{ challengeId: string; options: unknown }> {
		return this.#call("/api/auth/login/start", { method: "POST" });
	}

	loginFinish(body: {
		challengeId: string;
		response: unknown;
	}): Promise<{ userId: string; displayName: string; credentialId: string }> {
		return this.#call("/api/auth/login/finish", { method: "POST", body: JSON.stringify(body) });
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

	putWrap(
		kind: KeyWrap["kind"],
		payload: string,
		credentialId?: string,
		/** Nur bei "recovery": Kennung und Nachweis fuer den Weg zurueck. */
		recovery?: { recoveryId: string; vaultProof: string }
	): Promise<{ id: string }> {
		return this.#call("/api/wraps", {
			method: "POST",
			body: JSON.stringify({ kind, payload, credentialId, ...recovery })
		});
	}

	/** Schritt 1: die Verpackung zu einer Phrase holen. */
	recoverWrap(recoveryId: string): Promise<{ wrap: string }> {
		return this.#call("/api/auth/recover", {
			method: "POST",
			body: JSON.stringify({ recoveryId })
		});
	}

	/** Schritt 2: nachweisen, dass sie sich oeffnen liess - und ein Geraet anmelden. */
	recoverDevice(body: {
		recoveryId: string;
		proof: string;
		label: string;
	}): Promise<{ userId: string; displayName: string; deviceId: string; deviceToken: string }> {
		return this.#call("/api/auth/recover", { method: "POST", body: JSON.stringify(body) });
	}

	// ---------- Passkeys ----------
	//
	// Nur im Browser zu gebrauchen: ein Passkey haengt an der Domain, und die
	// Desktop-Anwendung hat keine. Sie koppelt sich stattdessen.

	passkeys(): Promise<{ passkeys: Passkey[] }> {
		return this.#call("/api/passkeys");
	}

	addPasskeyStart(): Promise<{ challengeId: string; options: unknown }> {
		return this.#call("/api/passkeys/start", { method: "POST" });
	}

	addPasskeyFinish(body: {
		challengeId: string;
		label?: string;
		hasPrf: boolean;
		response: unknown;
	}): Promise<Passkey> {
		return this.#call("/api/passkeys/finish", { method: "POST", body: JSON.stringify(body) });
	}

	renamePasskey(id: string, label: string): Promise<{ ok: boolean }> {
		return this.#call("/api/passkeys", {
			method: "PATCH",
			body: JSON.stringify({ id, label })
		});
	}

	removePasskey(id: string): Promise<{ ok: boolean }> {
		return this.#call("/api/passkeys", { method: "DELETE", body: JSON.stringify({ id }) });
	}

	// ---------- Verwaltung ----------

	invites(): Promise<{
		invites: Invite[];
		envInvitesConfigured?: boolean;
		envInvitesActive?: boolean;
		openRegistration?: boolean;
	}> {
		return this.#call("/api/admin/invites");
	}

	setOpenRegistration(openRegistration: boolean): Promise<{ ok: boolean; openRegistration: boolean }> {
		return this.#call("/api/admin/invites", {
			method: "PATCH",
			body: JSON.stringify({ openRegistration })
		});
	}

	setEnvInvites(active: boolean): Promise<{ ok: boolean; envInvitesActive: boolean }> {
		return this.#call("/api/admin/invites", {
			method: "PATCH",
			body: JSON.stringify({ active })
		});
	}

	createInvite(opts: { note?: string; gueltigTage?: number } = {}): Promise<Invite> {
		return this.#call("/api/admin/invites", { method: "POST", body: JSON.stringify(opts) });
	}

	revokeInvite(code: string): Promise<{ ok: boolean }> {
		return this.#call("/api/admin/invites", {
			method: "DELETE",
			body: JSON.stringify({ code })
		});
	}

	backups(): Promise<{ backups: BackupInfo[] }> {
		return this.#call("/api/admin/backups");
	}

	createBackup(): Promise<{ ok: boolean; backup: BackupInfo }> {
		return this.#call("/api/admin/backups", { method: "POST" });
	}

	restoreBackup(name: string): Promise<{ ok: boolean; restored: string; preRestoreBackup: string }> {
		return this.#call("/api/admin/backups/restore", {
			method: "POST",
			body: JSON.stringify({ name })
		});
	}

	deleteBackup(name: string): Promise<{ ok: boolean }> {
		return this.#call("/api/admin/backups", {
			method: "DELETE",
			body: JSON.stringify({ name })
		});
	}

	// ---------- Kopplung ----------

	/**
	 * Der Code wird MITGESCHICKT, nicht abgeholt: er ist der Abdruck des
	 * oeffentlichen Schluessels und entsteht auf dem Geraet (siehe pairingCode).
	 */
	pairStart(
		publicKey: string,
		label: string,
		code: string,
		claimHash: string
	): Promise<{ code: string; expiresAt: number }> {
		return this.#call("/api/pair/start", {
			method: "POST",
			body: JSON.stringify({ publicKey, label, code, claimHash })
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

	/** Das Geheimnis weist aus, nicht der Code - siehe createClaimSecret. */
	pairClaim(
		code: string,
		claimSecret: string
	): Promise<
		{ pending: true } | { pending: false; userId: string; wrappedKey: string; deviceToken: string }
	> {
		return this.#call("/api/pair/claim", {
			method: "POST",
			body: JSON.stringify({ code, claimSecret })
		});
	}

	/** Ein Geraet loesen. */
	revokeDevice(deviceId?: string): Promise<{ ok: boolean; deviceId: string }> {
		return this.#call("/api/devices", {
			method: "DELETE",
			body: JSON.stringify(deviceId ? { deviceId } : {})
		});
	}

	/** Eine Bestaetigung anfordern - eine WebAuthn-Aufgabe fuer diesen Passkey. */
	confirmStart(): Promise<{ challengeId: string; options: unknown }> {
		return this.#call("/api/me/confirm", { method: "POST" });
	}

	/** Das Konto aufloesen - alles, was der Server hat, verschwindet. */
	deleteAccount(confirm?: { challengeId: string; response: unknown }): Promise<DeleteSummary> {
		return this.#call<DeleteSummary>("/api/me", {
			method: "DELETE",
			body: JSON.stringify(confirm ?? {})
		});
	}

	/** Die Adresse des Weckruf-Kanals - den oeffnet der Aufrufer selbst. */
	streamUrl(): string {
		return `${this.#baseUrl}/api/sync/stream`;
	}

	/**
	 * Warten, bis der Server ueber `since` hinaus ist - fuer Clients ohne
	 * EventSource. Kommt nach etwa 25 Sekunden auch ohne Aenderung zurueck.
	 */
	waitForChange(since: number, signal?: AbortSignal): Promise<{ seq: number; changed: boolean }> {
		return this.#call<{ seq: number; changed: boolean }>(`/api/sync/wait?since=${since}`, {
			signal
		});
	}
}
