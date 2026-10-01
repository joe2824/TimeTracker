// Der Draht zum Server - Mitgliedsseite. Eigener, kleiner Client statt der
// grossen `Api`-Klasse aus sync/api.ts: die läuft mit Geräte-Token/Sitzung für
// ein Personenkonto, hier gibt es keins - nur den Team-Token im eigenen Kopf
// `x-team-token`, oder noch gar keinen (Vorschau, Beitritt).
import { requestJson, type FetchFn, type TeamActivity } from "../sync/api";
import { platformFetch } from "../platform/http";

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
	return requestJson(fetchFn, serverUrl, `/api/team/join?code=${encodeURIComponent(code)}`);
}

/**
 * Der Teamname hinter einem Verwalter-Link - wie previewTeamInvite, aber vom
 * eigenen Endpunkt, weil das Annehmen selbst (anders als bei Mitgliedern) ein
 * Konto braucht und deshalb ueber die authentifizierte Api-Klasse laeuft
 * (sync/api.ts#joinTeamAsAdmin), nicht über diesen kontolosen Client.
 */
export function previewAdminInvite(
	serverUrl: string,
	code: string,
	fetchFn: FetchFn = platformFetch
): Promise<{ teamName: string }> {
	return requestJson(fetchFn, serverUrl, `/api/team/admin/join?code=${encodeURIComponent(code)}`);
}

/** Beitreten - legt ein neues Mitglied an und liefert dessen Token. */
export function joinTeam(
	serverUrl: string,
	code: string,
	name: string,
	email?: string,
	fetchFn: FetchFn = platformFetch
): Promise<TeamJoinResult> {
	return requestJson(fetchFn, serverUrl, "/api/team/join", {
		method: "POST",
		body: JSON.stringify({ code, name, email })
	});
}

/** Die gemeinsame Aktivitätenliste - auf Zuruf, kein Push. */
export function fetchTeamActivities(
	serverUrl: string,
	token: string,
	fetchFn: FetchFn = platformFetch
): Promise<{ activities: TeamActivity[] }> {
	return requestJson(fetchFn, serverUrl, "/api/team/activities", { headers: { "x-team-token": token } });
}

/** Selbst austreten - der Token gilt danach nicht mehr. */
export function leaveTeamOnServer(
	serverUrl: string,
	token: string,
	fetchFn: FetchFn = platformFetch
): Promise<{ ok: boolean }> {
	return requestJson(fetchFn, serverUrl, "/api/team/membership", {
		method: "DELETE",
		headers: { "x-team-token": token }
	});
}

/** Wann der eigene Bericht des Monats beim Team einging - null, wenn noch keiner vorliegt. */
export function fetchOwnTeamReport(
	serverUrl: string,
	token: string,
	month: string,
	fetchFn: FetchFn = platformFetch
): Promise<{ submittedAt: number | null }> {
	return requestJson(fetchFn, serverUrl, `/api/team/reports?month=${encodeURIComponent(month)}`, {
		headers: { "x-team-token": token }
	});
}

/** Den eigenen Monatsbericht ablegen - der Chef bekommt genau das zu sehen. */
export function uploadTeamReport(
	serverUrl: string,
	token: string,
	month: string,
	report: unknown,
	fetchFn: FetchFn = platformFetch
): Promise<{ ok: boolean }> {
	return requestJson(fetchFn, serverUrl, "/api/team/reports", {
		method: "POST",
		headers: { "x-team-token": token },
		body: JSON.stringify({ month, report })
	});
}
