// Die gemeinsame Aktivitätenliste abrufen und lokal einfügen - auf Zuruf
// (App-Start, manuelles Aktualisieren), kein Push. Schreibend nur für die
// vom Team vorgegebenen Zeilen (Präfix "team:"); persönliche Aktivitäten
// bleiben unangetastet.
import { app } from "../app.svelte";
import { loadTeamDevice } from "../store";
import { fetchTeamActivities, type RemoteTeamActivity } from "./api";
import { chefTeams } from "./chef.svelte";
import { account } from "../sync/account.svelte";
import { teamJoin } from "./state.svelte";
import { logWarn } from "../log";
import { TEAM_ACTIVITY_PREFIX, type Activity } from "../types";

export { TEAM_ACTIVITY_PREFIX };

/** Nur die Felder, die beide Server-Antworten (Mitglied wie Chef) gemeinsam haben. */
interface RemoteActivityLike {
	id: string;
	name: string;
	isAbsence: boolean;
	sortOrder: number;
	color: string | null;
	archived: boolean;
}

function toLocal(remote: RemoteActivityLike, team: { id?: string; name: string }): Activity {
	return {
		id: `${TEAM_ACTIVITY_PREFIX}${remote.id}`,
		name: remote.name,
		isAbsence: remote.isAbsence,
		sortOrder: remote.sortOrder,
		archived: remote.archived,
		color: remote.color ?? undefined,
		teamOwned: true,
		teamName: team.name,
		teamId: team.id
	};
}

/**
 * Die gemeinsame Liste des Teams (falls dieses Gerät eines hat) neu einlesen.
 *
 * Ersetzt nur die Zeilen mit `teamOwned` - alles andere in `app.activities`
 * bleibt unverändert. Ohne Team-Mitgliedschaft ein stiller No-Op.
 */
export async function syncTeamActivities(): Promise<void> {
	const device = await loadTeamDevice();
	// Hier statt in jeder Komponente einzeln gelesen: läuft beim App-Start, hält
	// den reaktiven Zustand also auch dann aktuell, wenn niemand die
	// Einstellungen öffnet.
	teamJoin.device = device;
	if (!device) return;

	let remote: RemoteTeamActivity[];
	try {
		remote = (await fetchTeamActivities(device.serverUrl, device.token)).activities;
	} catch (e) {
		logWarn("Team-Aktivitäten konnten nicht geladen werden", e);
		return;
	}

	// Zwischenzeitlich könnte "Team verlassen" gelaufen sein (löscht team.json) -
	// eine erst jetzt schreibende Antwort würde die gerade entfernten
	// Team-Aktivitäten sonst wieder aufleben lassen.
	const stillMember = await loadTeamDevice();
	if (!stillMember || stillMember.token !== device.token) return;

	const remoteIds = new Set(remote.map((r) => `${TEAM_ACTIVITY_PREFIX}${r.id}`));
	const personal = app.activities.filter((a) => !a.teamOwned);
	// Eine vom Chef aus der Liste entfernte Zeile nicht einfach verschwinden
	// lassen: report.ts baut seine Zeilen nur aus der aktuellen activities-Liste,
	// schon erfasste Stunden gingen sonst lautlos verloren. Dieselbe Statur wie
	// beim Team verlassen (app.svelte.ts#detachTeamActivities) - nur mit
	// UNVERÄNDERTER Id, weil der Server-Eintrag endgültig weg ist und nie wieder
	// mit ihr kollidieren kann.
	const detached = app.activities
		.filter((a) => a.teamOwned && !remoteIds.has(a.id))
		.map(({ teamOwned: _teamOwned, teamName: _teamName, teamId: _teamId, ...rest }) => ({
			...rest,
			archived: true
		}));
	app.activities = [
		...personal,
		...detached,
		...remote.map((r) => toLocal(r, { name: device.teamName }))
	];
	await app.persistActivities();
}

/**
 * Die selbst verwalteten Team-Listen des Chefs in app.activities spiegeln.
 *
 * Ohne das taucht eine Team-Aktivität in der eigenen Zeiterfassung (Auswahl,
 * Bericht, Ausblenden) nie auf - der Chef sieht sie nur in der separaten
 * Verwaltung im Aktivitäten-Tab, nie beim eigenen Timer. Ein Team je
 * Durchgang: das Entfernen einer Zeile in Team A darf Team B nicht anfassen,
 * und nur der eigene Anteil (teamId) einer Zeile zählt als "zu diesem Team
 * gehörig" - anders als bei syncTeamActivities gibt es hier ggf. mehrere
 * Teams gleichzeitig.
 */
export async function syncOwnedTeamActivities(): Promise<void> {
	if (!account.linked) return;
	await chefTeams.loadTeams();

	for (const team of chefTeams.teams) {
		let remote;
		try {
			remote = await account.listTeamActivities(team.id);
		} catch (e) {
			logWarn(`Aktivitäten von Team „${team.name}" konnten nicht geladen werden`, e);
			continue;
		}

		const remoteIds = new Set(remote.map((r) => `${TEAM_ACTIVITY_PREFIX}${r.id}`));
		const ownedByThisTeam = (a: Activity) => a.teamOwned === true && a.teamId === team.id;
		const rest = app.activities.filter((a) => !ownedByThisTeam(a));
		const detached = app.activities
			.filter((a) => ownedByThisTeam(a) && !remoteIds.has(a.id))
			.map(({ teamOwned: _teamOwned, teamName: _teamName, teamId: _teamId, ...r }) => ({
				...r,
				archived: true
			}));
		app.activities = [...rest, ...detached, ...remote.map((r) => toLocal(r, team))];
	}

	await app.persistActivities();
}
