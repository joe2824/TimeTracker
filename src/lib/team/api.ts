// Der Draht zum Server - Mitgliedsseite. Eigener, kleiner Client statt der
// grossen `Api`-Klasse aus sync/api.ts: die läuft mit Geräte-Token/Sitzung für
// ein Personenkonto, hier gibt es keins - nur den Team-Token im eigenen Kopf
// `x-team-token`, oder noch gar keinen (Vorschau, Beitritt).
import { ApiError, normalizeServerUrl, type FetchFn } from "../sync/api";
import { platformFetch } from "../platform/http";

async function call<T>(
	fetchFn: FetchFn,
	baseUrl: string,
	path: string,
	init: RequestInit = {}
): Promise<T> {
	let res: Response;
	try {
		res = await fetchFn(`${normalizeServerUrl(baseUrl)}${path}`, {
			...init,
			headers: { "content-type": "application/json", ...(init.headers ?? {}) }
		});
	} catch (e) {
		throw new ApiError(e instanceof Error ? e.message : "Server nicht erreichbar", 0);
	}
	if (!res.ok) {
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

export interface TeamJoinResult {
	teamMemberId: string;
	token: string;
	teamName: string;
}

/** Der Teamname hinter einem Link - vor dem Beitreten, zum Anzeigen. */
export function previewTeamInvite(
	serverUrl: string,
	code: string,
	fetchFn: FetchFn = platformFetch
): Promise<{ teamName: string }> {
	return call(fetchFn, serverUrl, `/api/team/join?code=${encodeURIComponent(code)}`);
}

/** Beitreten - legt ein neues Mitglied an und liefert dessen Token. */
export function joinTeam(
	serverUrl: string,
	code: string,
	name: string,
	email?: string,
	fetchFn: FetchFn = platformFetch
): Promise<TeamJoinResult> {
	return call(fetchFn, serverUrl, "/api/team/join", {
		method: "POST",
		body: JSON.stringify({ code, name, email })
	});
}

export interface RemoteTeamActivity {
	id: string;
	name: string;
	isAbsence: boolean;
	sortOrder: number;
	color: string | null;
	archived: boolean;
	updatedAt: number;
}

/** Die gemeinsame Aktivitätenliste - auf Zuruf, kein Push. */
export function fetchTeamActivities(
	serverUrl: string,
	token: string,
	fetchFn: FetchFn = platformFetch
): Promise<{ activities: RemoteTeamActivity[] }> {
	return call(fetchFn, serverUrl, "/api/team/activities", { headers: { "x-team-token": token } });
}

/** Den eigenen Monatsbericht ablegen - der Chef bekommt genau das zu sehen. */
export function uploadTeamReport(
	serverUrl: string,
	token: string,
	month: string,
	report: unknown,
	fetchFn: FetchFn = platformFetch
): Promise<{ ok: boolean }> {
	return call(fetchFn, serverUrl, "/api/team/reports", {
		method: "POST",
		headers: { "x-team-token": token },
		body: JSON.stringify({ month, report })
	});
}
