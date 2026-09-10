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

	const personal = app.activities.filter((a) => !a.teamOwned);
	app.activities = [...personal, ...remote.map(toLocal)];
	await app.persistActivities();
}
