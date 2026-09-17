// Die gemeinsame Aktivitätenliste abrufen und lokal einfügen - auf Zuruf
// (App-Start, manuelles Aktualisieren), kein Push. Schreibend nur für die
// vom Team vorgegebenen Zeilen (Präfix "team:"); persönliche Aktivitäten
// bleiben unangetastet.
import { app } from "../app.svelte";
import { clearTeamDevice, loadTeamDevice } from "../store";
import { fetchTeamActivities, type RemoteTeamActivity } from "./api";
import { chefTeams } from "./chef.svelte";
import { account } from "../sync/account.svelte";
import { ApiError } from "../sync/api";
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
 * Serialisiert jeden schreibenden Zugriff auf app.activities, der von hier
 * oder von einer Team-Zusammenführung (ActivitiesPanel) ausgeht. Ohne das
 * überschreibt eine spät auflösende Anfrage mit ihrem eigenen, inzwischen
 * veralteten Ausgangsstand, was eine andere Operation dazwischen schon
 * geschrieben hat - genau die Art Race, die diesem Projekt schon einmal
 * Team-Daten gekostet hat. Gleiches Muster wie SyncEngine#serial.
 */
let chain: Promise<unknown> = Promise.resolve();
export function withActivitiesLock<T>(fn: () => Promise<T>): Promise<T> {
	const run = chain.then(fn, fn);
	chain = run.catch(() => {});
	return run;
}

/**
 * Die gemeinsame Liste des Teams (falls dieses Gerät eines hat) neu einlesen.
 *
 * Ersetzt nur die Zeilen mit `teamOwned` UND ohne eigene teamId - das sind
 * die über den Beitritts-Link gespiegelten. Eigene, per syncOwnedTeamActivities
 * gespiegelte Zeilen (Konto ist gleichzeitig Chef eines anderen Teams) tragen
 * immer eine teamId und bleiben unangetastet. Ohne Team-Mitgliedschaft ein
 * stiller No-Op.
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
		// 401 heisst: der Token gilt nicht mehr - das Team wurde geloescht oder
		// dieses Mitglied entfernt. Ohne diesen Zweig bliebe teamJoin.device stehen
		// und die gespiegelten Zeilen zeigten fuer immer auf ein Team, das es nicht
		// mehr gibt (jeder andere Fehler bleibt ein blosser Netz-Aussetzer).
		if (e instanceof ApiError && e.status === 401) {
			await clearTeamDevice();
			teamJoin.device = null;
			await app.detachTeamActivities();
			return;
		}
		logWarn("Team-Aktivitäten konnten nicht geladen werden", e);
		return;
	}

	await withActivitiesLock(async () => {
		// Zwischenzeitlich könnte "Team verlassen" gelaufen sein (löscht team.json) -
		// eine erst jetzt schreibende Antwort würde die gerade entfernten
		// Team-Aktivitäten sonst wieder aufleben lassen.
		const stillMember = await loadTeamDevice();
		if (!stillMember || stillMember.token !== device.token) return;

		const remoteIds = new Set(remote.map((r) => `${TEAM_ACTIVITY_PREFIX}${r.id}`));
		const isJoinedTeamRow = (a: Activity) => a.teamOwned === true && a.teamId === undefined;
		const rest = app.activities.filter((a) => !isJoinedTeamRow(a));
		// Eine vom Chef aus der Liste entfernte Zeile nicht einfach verschwinden
		// lassen: report.ts baut seine Zeilen nur aus der aktuellen activities-Liste,
		// schon erfasste Stunden gingen sonst lautlos verloren. Dieselbe Statur wie
		// beim Team verlassen (app.svelte.ts#detachTeamActivities) - nur mit
		// UNVERÄNDERTER Id, weil der Server-Eintrag endgültig weg ist und nie wieder
		// mit ihr kollidieren kann.
		const detached = app.activities
			.filter((a) => isJoinedTeamRow(a) && !remoteIds.has(a.id))
			.map(({ teamOwned: _teamOwned, teamName: _teamName, teamId: _teamId, ...rest2 }) => ({
				...rest2,
				archived: true
			}));
		app.activities = [
			...rest,
			...detached,
			...remote.map((r) => toLocal(r, { name: device.teamName }))
		];
		await app.persistActivities();
	});
}

/**
 * Die selbst verwalteten Team-Listen des Chefs in app.activities spiegeln.
 *
 * Ohne das taucht eine Team-Aktivität in der eigenen Zeiterfassung (Auswahl,
 * Bericht, Ausblenden) nie auf - der Chef sieht sie nur in der separaten
 * Verwaltung im Aktivitäten-Tab, nie beim eigenen Timer. Holt alle Teams
 * parallel und schreibt app.activities genau einmal, nicht einmal je Team -
 * jeder Zwischenstand wäre ein zusätzlicher reaktiver Durchlauf für nichts.
 *
 * Ein Team, das es gar nicht mehr gibt (endgültig gelöscht statt nur eine
 * Zeile draus entfernt), taucht in chefTeams.teams überhaupt nicht mehr auf -
 * ohne den Zusatz unten sähe die Schleife danach nur noch existierende Teams
 * und liesse dessen Zeilen für immer als "teamOwned" stehen.
 */
export async function syncOwnedTeamActivities(): Promise<void> {
	if (!account.linked) return;
	await chefTeams.loadTeams();

	const currentTeams = new Map(chefTeams.teams.map((t) => [t.id, t]));
	const deletedTeamIds = new Set(
		app.activities
			.filter((a) => a.teamOwned && a.teamId !== undefined && !currentTeams.has(a.teamId))
			.map((a) => a.teamId!)
	);
	if (currentTeams.size === 0 && deletedTeamIds.size === 0) return;

	const results = await Promise.all([
		...chefTeams.teams.map(async (team) => {
			try {
				return { team, remote: await account.listTeamActivities(team.id) };
			} catch (e) {
				logWarn(`Aktivitäten von Team „${team.name}" konnten nicht geladen werden`, e);
				return null;
			}
		}),
		...[...deletedTeamIds].map((teamId) =>
			Promise.resolve({ team: { id: teamId, name: "" }, remote: [] })
		)
	]);

	await withActivitiesLock(async () => {
		let next = app.activities;
		for (const result of results) {
			if (!result) continue;
			const { team, remote } = result;
			const remoteIds = new Set(remote.map((r) => `${TEAM_ACTIVITY_PREFIX}${r.id}`));
			const ownedByThisTeam = (a: Activity) => a.teamOwned === true && a.teamId === team.id;
			const rest = next.filter((a) => !ownedByThisTeam(a));
			const detached = next
				.filter((a) => ownedByThisTeam(a) && !remoteIds.has(a.id))
				.map(({ teamOwned: _teamOwned, teamName: _teamName, teamId: _teamId, ...r }) => ({
					...r,
					archived: true
				}));
			next = [...rest, ...detached, ...remote.map((r) => toLocal(r, team))];
		}
		app.activities = next;
		await app.persistActivities();
	});
}
