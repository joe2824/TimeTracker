// Die gemeinsame Aktivitätenliste abrufen und lokal einfügen - auf Zuruf
// (App-Start, manuelles Aktualisieren), kein Push. Schreibend nur für die
// vom Team vorgegebenen Zeilen (Präfix "team:"); persönliche Aktivitäten
// bleiben unangetastet.
import { app } from "../app.svelte";
import { loadTeamDevice } from "../store";
import { fetchTeamActivities, type RemoteTeamActivity } from "./api";
import { teamJoin } from "./state.svelte";
import { logWarn } from "../log";
import { TEAM_ACTIVITY_PREFIX, type Activity } from "../types";

export { TEAM_ACTIVITY_PREFIX };

function toLocal(remote: RemoteTeamActivity): Activity {
	return {
		id: `${TEAM_ACTIVITY_PREFIX}${remote.id}`,
		name: remote.name,
		isAbsence: remote.isAbsence,
		sortOrder: remote.sortOrder,
		archived: remote.archived,
		color: remote.color ?? undefined,
		teamOwned: true
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
		.map(({ teamOwned: _teamOwned, ...rest }) => ({ ...rest, archived: true }));
	app.activities = [...personal, ...detached, ...remote.map(toLocal)];
	await app.persistActivities();
}
