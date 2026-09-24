// Der Draht zum Server.
import type { WrapKind } from "../crypto/vault";
import { TELEMETRY_KEY } from "../defaults";

export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

/** So lange wartet das Abmelden auf den Server, bevor es ohne ihn weitermacht. */
const LOGOUT_MS = 5000;

/** Was die anonyme Tagesmeldung enthält - und sonst nichts. */
export interface TelemetryPing {
	deviceId: string;
	version: string;
	platform: string;
}

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

export interface ServerStats {
	/** Konten auf diesem Server - keine Telemetrie, sondern eine echte Zählung. */
	users: number;
	summary: {
		today: number;
		yesterday: number;
		wau: number;
		mau: number;
		totalPings: number;
		versions: Record<string, number>;
		platforms: Record<string, number>;
	};
	history: {
		date: string;
		dau: number;
		versions: Record<string, number>;
		platforms: Record<string, number>;
	}[];
}


export interface Passkey {
	id: string;
	/** Wie der Mensch ihn nennt. Null, solange niemand ihn benannt hat. */
	label: string | null;
	/** Ob der Vault-Schlüssel für ihn verpackt vorliegt - dann öffnet er die Daten allein. */
	hasWrap: boolean;
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

export interface TeamInfo {
	id: string;
	ownerUserId: string;
	name: string;
	createdAt: number;
	/** Nur bei listTeams() gefuellt - die eigene Rolle in diesem Team. */
	role?: "owner" | "admin";
}

export interface TeamInvite {
	code: string;
	teamId: string;
	createdAt: number;
	expiresAt: number | null;
	revokedAt: number | null;
}

export interface TeamAdminInfo {
	userId: string;
	displayName: string;
	email: string | null;
	createdAt: number;
}

export interface TeamMemberInfo {
	id: string;
	name: string;
	/** Freiwillig - nur für die Erinnerung an Fehlende. */
	email: string | null;
	createdAt: number;
	lastSeenAt: number | null;
	revokedAt: number | null;
}

export interface TeamReportStatus {
	memberId: string;
	memberName: string;
	memberEmail: string | null;
	/** null = für den abgefragten Monat noch nichts eingegangen. */
	submittedAt: number | null;
	/** Die Form von MonthReport (report/report.ts) - dem Transport nach undurchsichtig. */
	payload: unknown | null;
}

export interface TeamActivity {
	id: string;
	name: string;
	isAbsence: boolean;
	sortOrder: number;
	color: string | null;
	archived: boolean;
	updatedAt: number;
}

export interface TeamActivityInput {
	/** Fehlt sie, vergibt der Server eine neue - so entsteht eine Zeile. */
	id?: string;
	name: string;
	isAbsence: boolean;
	sortOrder: number;
	color?: string | null;
	archived: boolean;
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

/** Was beim Auflösen eines Kontos vom Server verschwunden ist. */
export interface DeleteSummary {
	ok: boolean;
	records: number;
	devices: number;
	passkeys: number;
	wraps: number;
	/** Fehlt bei einem Server vor 1.1. */
	teamsTransferred?: number;
	teamsDeleted?: number;
}

/**
 * Die Fehlerantwort des Servers als ApiError. SvelteKit schickt seine Fehler
 * als JSON mit `message`; ist da etwas anderes, bleibt der Statustext -
 * besser als eine leere Meldung.
 */
export async function apiErrorFrom(res: Response): Promise<ApiError> {
	const text = await res.text().catch(() => "");
	let message = res.statusText || `Fehler ${res.status}`;
	try {
		const parsed = JSON.parse(text);
		if (parsed?.message) message = String(parsed.message);
	} catch {
		if (text) message = text.slice(0, 200);
	}
	return new ApiError(message, res.status);
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

	/** Lohnt ein späterer Versuch? */
	get retryable(): boolean {
		return this.status === 0 || this.status === 429 || this.status >= 500;
	}
}

export interface ApiOptions {
	baseUrl: string;
	/** Das Geräte-Token. Ohne eines läuft die Anfrage über das Sitzungs-Cookie. */
	token?: string | null;
	fetchFn?: FetchFn;
}

/** Server-URL bereinigen: Protokoll/Host kleinschreiben, Trailing Slash entfernen. */
export function normalizeServerUrl(raw: string): string {
	let u = raw.trim().replace(/\/+$/, "");
	if (!u) return "";
	if (!/^https?:\/\//i.test(u)) {
		u = `https://${u}`;
	}
	try {
		const parsed = new URL(u);
		parsed.protocol = parsed.protocol.toLowerCase();
		parsed.hostname = parsed.hostname.toLowerCase();
		return parsed.origin + (parsed.pathname === "/" ? "" : parsed.pathname.replace(/\/+$/, ""));
	} catch {
		return u;
	}
}

export class Api {
	#baseUrl: string;
	#token: string | null;
	#fetch: FetchFn;

	constructor(opts: ApiOptions) {
		this.#baseUrl = normalizeServerUrl(opts.baseUrl);
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
				// Ohne Token läuft es über das Cookie - das muss ausdrücklich mit.
				credentials: this.#token ? "omit" : "include"
			});
		} catch (e) {
			if (init.signal?.aborted) {
				throw new ApiError("Anfrage abgebrochen", 0);
			}
			// Kein Netz, Name nicht auflösbar, Verbindung abgebrochen. Status 0 heisst
			// "gar nicht erst angekommen" und ist damit immer einen zweiten Versuch wert.
			throw new ApiError(e instanceof Error ? e.message : "Server nicht erreichbar", 0);
		}

		if (!res.ok) throw await apiErrorFrom(res);

		try {
			return (await res.json()) as T;
		} catch (e) {
			if (init.signal?.aborted) {
				throw new ApiError("Anfrage abgebrochen", 0);
			}
			throw e;
		}
	}

	// ---------- Telemetrie ----------

	/**
	 * Die anonyme Tagesmeldung. Läuft über denselben Weg wie alles andere und
	 * weist sich damit genauso aus: mit dem Gerätetoken, sonst mit dem Cookie.
	 *
	 * Der Schlüssel aus dem Build kommt dazu - die Desktop-Anwendung hat ihn,
	 * die PWA nicht. Der Server nimmt eines von beidem.
	 */
	async telemetry(body: TelemetryPing): Promise<void> {
		await this.#call<{ ok: boolean }>("/api/telemetry", {
			method: "POST",
			body: JSON.stringify(body),
			headers: TELEMETRY_KEY ? { "x-telemetry-key": TELEMETRY_KEY } : {}
		});
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
		// Mit Zeitlimit, als einziger Aufruf: das örtliche Abmelden - Vault-
		// schlüssel und Bestand weg - darf nicht daran hängen, ob der Server
		// gerade antwortet. Bleibt die Verbindung stumm, läuft die Sitzung dort
		// von selbst ab; hier zählt, dass nichts liegen bleibt.
		const abort = new AbortController();
		const timer = setTimeout(() => abort.abort(), LOGOUT_MS);
		return this.#call<{ ok: boolean }>("/api/auth/logout", {
			method: "POST",
			signal: abort.signal
		}).finally(() => clearTimeout(timer));
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
		response: unknown;
		/** Pflicht - ohne sie gäbe es keinen Weg zurück ins Konto. */
		recoveryWrap: { payload: string; recoveryId: string; vaultProof: string };
		/** Fehlt nur, wenn der Authentifikator kein PRF kann. */
		passkeyWrap?: { payload: string } | null;
	}): Promise<{ userId: string; displayName: string }> {
		return this.#call("/api/auth/register/finish", {
			method: "POST",
			body: JSON.stringify(body)
		});
	}

	/** Ein Konto von diesem Gerät aus anlegen - ohne Passkey. */
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

	/**
	 * `buckets` schränkt auf einzelne Zeiträume ein; ohne die Angabe kommt
	 * alles. Eine leere Liste liefert nichts - das ist der Unterschied zu "keine
	 * Angabe" und beim Vorziehen einzelner Monate genau der gewollte.
	 */
	pull(
		since: number,
		opts: { limit?: number; buckets?: string[]; unbucketed?: boolean } = {}
	): Promise<PullPage> {
		const q = new URLSearchParams({ since: String(since) });
		if (opts.limit) q.set("limit", String(opts.limit));
		if (opts.buckets) for (const b of opts.buckets) q.append("bucket", b);
		if (opts.unbucketed) q.set("unbucketed", "1");
		return this.#call<PullPage>(`/api/sync?${q}`);
	}

	/**
	 * Welche Zeitraum-Kennungen das Konto hat. Der Client rechnet daraus zurück,
	 * zu welchen Monaten es Daten gibt - auch zu noch nicht geholten.
	 */
	buckets(): Promise<{ buckets: string[] }> {
		return this.#call("/api/sync/buckets");
	}

	push(records: OutgoingRecord[]): Promise<PushAnswer> {
		return this.#call<PushAnswer>("/api/sync", {
			method: "POST",
			body: JSON.stringify({ records })
		});
	}

	// ---------- Schlüssel ----------

	wraps(): Promise<{ wraps: { id: string; kind: string; credentialId: string | null; payload: string }[] }> {
		return this.#call("/api/wraps");
	}

	putWrap(
		kind: WrapKind,
		payload: string,
		credentialId?: string,
		/** Nur bei "recovery": Kennung und Nachweis für den Weg zurück. */
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

	/** Schritt 2: nachweisen, dass sie sich öffnen liess - und ein Gerät anmelden. */
	recoverDevice(body: {
		recoveryId: string;
		proof: string;
		label: string;
	}): Promise<{ userId: string; displayName: string; deviceId: string; deviceToken: string }> {
		return this.#call("/api/auth/recover", { method: "POST", body: JSON.stringify(body) });
	}

	// ---------- Passkeys ----------
	//
	// Nur im Browser zu gebrauchen: ein Passkey hängt an der Domain, und die
	// Desktop-Anwendung hat keine. Sie koppelt sich stattdessen.

	addPasskeyStart(): Promise<{ challengeId: string; options: unknown }> {
		return this.#call("/api/passkeys/start", { method: "POST" });
	}

	addPasskeyFinish(body: {
		challengeId: string;
		label?: string;
		response: unknown;
	}): Promise<{ id: string; label: string | null }> {
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

	createInvite(opts: { note?: string; validDays?: number } = {}): Promise<Invite> {
		return this.#call("/api/admin/invites", { method: "POST", body: JSON.stringify(opts) });
	}

	revokeInvite(code: string): Promise<{ ok: boolean }> {
		return this.#call("/api/admin/invites", {
			method: "DELETE",
			body: JSON.stringify({ code })
		});
	}

	// ---------- Team-Modus ----------
	//
	// Der Chef ist hier einfach dieses Konto - eigene, klartext-relationale
	// Tabellen auf dem Server, ausserhalb des Ende-zu-Ende-verschlüsselten
	// Sync-Systems. Siehe server/src/lib/server/teams.ts.

	listTeams(): Promise<{ teams: TeamInfo[] }> {
		return this.#call("/api/team");
	}

	createTeam(name: string): Promise<TeamInfo> {
		return this.#call("/api/team", { method: "POST", body: JSON.stringify({ name }) });
	}

	/** Endgültig - Mitglieder, Aktivitäten und Berichte gehen mit (Server-seitige Kaskade). */
	deleteTeam(teamId: string): Promise<{ ok: boolean }> {
		return this.#call(`/api/team/${encodeURIComponent(teamId)}`, { method: "DELETE" });
	}

	getTeamInvite(teamId: string): Promise<{ invite: TeamInvite | null }> {
		return this.#call(`/api/team/${encodeURIComponent(teamId)}/invite`);
	}

	/** Erzeugt einen neuen Link und widerruft dabei den bisherigen. */
	rotateTeamInvite(teamId: string): Promise<TeamInvite> {
		return this.#call(`/api/team/${encodeURIComponent(teamId)}/invite`, { method: "POST" });
	}

	listTeamMembers(teamId: string): Promise<{ members: TeamMemberInfo[] }> {
		return this.#call(`/api/team/${encodeURIComponent(teamId)}/members`);
	}

	revokeTeamMember(teamId: string, memberId: string): Promise<{ ok: boolean }> {
		return this.#call(`/api/team/${encodeURIComponent(teamId)}/members`, {
			method: "DELETE",
			body: JSON.stringify({ memberId })
		});
	}

	// ---------- Verwalter: ein zweites Konto neben dem Chef ----------

	listTeamAdmins(teamId: string): Promise<{ admins: TeamAdminInfo[] }> {
		return this.#call(`/api/team/${encodeURIComponent(teamId)}/admins`);
	}

	/** Nimmt den Zugang wieder zurück - der Chef selbst bleibt unberührt (läuft über ownerUserId). */
	removeTeamAdmin(teamId: string, userId: string): Promise<{ ok: boolean }> {
		return this.#call(`/api/team/${encodeURIComponent(teamId)}/admins`, {
			method: "DELETE",
			body: JSON.stringify({ userId })
		});
	}

	getAdminInvite(teamId: string): Promise<{ invite: TeamInvite | null }> {
		return this.#call(`/api/team/${encodeURIComponent(teamId)}/admin-invite`);
	}

	/** Erzeugt einen neuen Verwalter-Link und widerruft dabei den bisherigen. */
	rotateAdminInvite(teamId: string): Promise<TeamInvite> {
		return this.#call(`/api/team/${encodeURIComponent(teamId)}/admin-invite`, { method: "POST" });
	}

	/** Annehmen - braucht ein angemeldetes Konto, anders als der einfache Mitglieds-Beitritt. */
	joinTeamAsAdmin(code: string): Promise<TeamInfo> {
		return this.#call("/api/team/admin/join", { method: "POST", body: JSON.stringify({ code }) });
	}

	/** Besitz übergeben - das Ziel muss bereits Verwalter dieses Teams sein. */
	transferTeamOwnership(teamId: string, newOwnerUserId: string): Promise<{ ok: boolean }> {
		return this.#call(`/api/team/${encodeURIComponent(teamId)}/owner`, {
			method: "POST",
			body: JSON.stringify({ newOwnerUserId })
		});
	}

	listTeamActivities(teamId: string): Promise<{ activities: TeamActivity[] }> {
		return this.#call(`/api/team/${encodeURIComponent(teamId)}/activities`);
	}

	/**
	 * Voller Ersatz - in der Regel die einzige Feder (der Chef), kein
	 * Zusammenführen nötig. `expectedVersion` (der höchste `updatedAt`-Stand, den
	 * der Aufrufer zuletzt gesehen hat) lehnt der Server mit 409 ab, wenn sich
	 * die Liste zwischenzeitlich anderswo geändert hat (z.B. zweiter Tab).
	 */
	setTeamActivities(
		teamId: string,
		activities: TeamActivityInput[],
		expectedVersion?: number
	): Promise<{ activities: TeamActivity[] }> {
		return this.#call(`/api/team/${encodeURIComponent(teamId)}/activities`, {
			method: "PUT",
			body: JSON.stringify({ activities, expectedVersion })
		});
	}

	listTeamReports(teamId: string, month: string): Promise<{ reports: TeamReportStatus[] }> {
		return this.#call(
			`/api/team/${encodeURIComponent(teamId)}/reports?month=${encodeURIComponent(month)}`
		);
	}

	/** Von Hand als gesendet markieren - für Berichte, die nicht über die App kamen. */
	markTeamReportSent(teamId: string, memberId: string, month: string): Promise<{ ok: boolean }> {
		return this.#call(`/api/team/${encodeURIComponent(teamId)}/reports`, {
			method: "POST",
			body: JSON.stringify({ memberId, month })
		});
	}

	/**
	 * Eine Markierung zurücknehmen - wieder "kein Bericht". `expectedSubmittedAt`
	 * ist der Stand, den die Ansicht beim Klick zeigte - stimmt er nicht mehr mit
	 * dem Server überein (zwischenzeitlich echt eingegangen), lehnt der Server
	 * mit 409 ab, statt den neueren Bericht zu löschen.
	 */
	clearTeamReportStatus(
		teamId: string,
		memberId: string,
		month: string,
		expectedSubmittedAt: number
	): Promise<{ ok: boolean }> {
		return this.#call(`/api/team/${encodeURIComponent(teamId)}/reports`, {
			method: "DELETE",
			body: JSON.stringify({ memberId, month, expectedSubmittedAt })
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

	stats(days = 30): Promise<ServerStats> {
		return this.#call(`/api/admin/stats?days=${days}`);
	}

	// ---------- Kopplung ----------


	/**
	 * Der Code wird MITGESCHICKT, nicht abgeholt: er ist der Abdruck des
	 * öffentlichen Schlüssels und entsteht auf dem Gerät (siehe pairingCode).
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

	/** Ein Gerät lösen. */
	revokeDevice(deviceId?: string): Promise<{ ok: boolean; deviceId: string }> {
		return this.#call("/api/devices", {
			method: "DELETE",
			body: JSON.stringify(deviceId ? { deviceId } : {})
		});
	}

	/** Eine Bestätigung anfordern - eine WebAuthn-Aufgabe für diesen Passkey. */
	confirmStart(): Promise<{ challengeId: string; options: unknown }> {
		return this.#call("/api/me/confirm", { method: "POST" });
	}

	/** Das Konto auflösen - alles, was der Server hat, verschwindet. */
	deleteAccount(confirm?: { challengeId: string; response: unknown }): Promise<DeleteSummary> {
		return this.#call<DeleteSummary>("/api/me", {
			method: "DELETE",
			body: JSON.stringify(confirm ?? {})
		});
	}

	/** Die Adresse des Weckruf-Kanals - den öffnet der Aufrufer selbst. */
	streamUrl(): string {
		return `${this.#baseUrl}/api/sync/stream`;
	}

	/**
	 * Warten, bis der Server über `since` hinaus ist - für Clients ohne
	 * EventSource. Kommt nach etwa 25 Sekunden auch ohne Änderung zurück.
	 */
	waitForChange(since: number, signal?: AbortSignal): Promise<{ seq: number; changed: boolean }> {
		return this.#call<{ seq: number; changed: boolean }>(`/api/sync/wait?since=${since}`, {
			signal
		});
	}
}
