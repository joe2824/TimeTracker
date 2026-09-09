// Die gemeinsame Aktivitätenliste abrufen und lokal einfügen - auf Zuruf
// (App-Start, manuelles Aktualisieren), kein Push. Schreibend nur für die
// vom Team vorgegebenen Zeilen (Präfix "team:"); persönliche Aktivitäten
// bleiben unangetastet.
import { app } from "../app.svelte";
import { loadTeamDevice } from "../store";
import { fetchTeamActivities, type RemoteTeamActivity } from "./api";
import { logWarn } from "../log";
import type { Activity } from "../types";

/** Präfix der lokalen Id - kann nie mit einer selbst angelegten (crypto.randomUUID()) kollidieren. */
export const TEAM_ACTIVITY_PREFIX = "team:";

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
	if (!device) return;

	let remote: RemoteTeamActivity[];
	try {
		remote = (await fetchTeamActivities(device.serverUrl, device.token)).activities;
	} catch (e) {
		logWarn("Team-Aktivitäten konnten nicht geladen werden", e);
		return;
	}

	const personal = app.activities.filter((a) => !a.teamOwned);
	app.activities = [...personal, ...remote.map(toLocal)];
	await app.persistActivities();
}
