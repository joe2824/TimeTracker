// Die gemeinsame Aktivitätenliste abrufen und lokal einfügen - auf Zuruf
// (App-Start, manuelles Aktualisieren), kein Push. Schreibend nur für die
// vom Team vorgegebenen Zeilen (Präfix "team:"); persönliche Aktivitäten
// bleiben unangetastet.
import { app } from "../app.svelte";
import { clearTeamDevice, loadTeamDevice, loadTeamRemovedFrom, saveTeamRemovedFrom } from "../store";
import { fetchTeamActivities, leaveTeamOnServer, type RemoteTeamActivity } from "./api";
import { chefTeams } from "./chef.svelte";
import { account } from "../sync/account.svelte";
import { ApiError, type TeamActivity } from "../sync/api";
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

/** Über den Beitritts-Link gespiegelt - eigene Team-Listen des Chefs tragen stattdessen eine teamId. */
export const isJoinedTeamRow = (a: Activity): boolean => a.teamOwned === true && a.teamId === undefined;

/**
 * Doppelte Ids verwerfen, die erste gewinnt. Tritt ein Chef dem eigenen Team
 * per Link bei, kommt dieselbe Server-Id über beide Wege an - zwei Zeilen mit
 * derselben Id zählten ihre Stunden im Bericht doppelt.
 */
function withoutDuplicateIds(list: Activity[]): Activity[] {
	const seen = new Set<string>();
	return list.filter((a) => {
		if (seen.has(a.id)) {
			logWarn(`Aktivität doppelt, zweite Zeile verworfen: ${a.name}`, { id: a.id });
			return false;
		}
		seen.add(a.id);
		return true;
	});
}

/** Ergebnis eines Abgleichs - "offline" und "removed" braucht die Oberfläche, um nicht fälschlich "aktualisiert" zu melden. */
export type TeamSyncResult = "none" | "ok" | "offline" | "removed";

/**
 * Zählt jeden Abgleich durch. Verworfen wird eine Antwort nur, wenn schon ein
 * NEUERER Abgleich geschrieben hat - nicht schon, wenn nur ein neuerer
 * begonnen hat: scheitert der offline, bliebe sonst gar nichts stehen.
 */
let memberSyncSeq = 0;
let memberSyncApplied = 0;
let ownedSyncSeq = 0;
let ownedSyncApplied = 0;

/** Eigene Team-Liste des Chefs - hat bei einer Kollision mit einer beigetretenen Zeile Vorrang. */
const isOwnTeamRow = (a: Activity): boolean => a.teamOwned === true && a.teamId !== undefined;

/**
 * Die gemeinsame Liste des Teams (falls dieses Gerät eines hat) neu einlesen.
 *
 * Ersetzt nur die Zeilen aus isJoinedTeamRow. Eigene, per
 * syncOwnedTeamActivities gespiegelte Zeilen (Konto ist gleichzeitig Chef
 * eines anderen Teams) bleiben unangetastet.
 */
export async function syncTeamActivities(): Promise<TeamSyncResult> {
	const seq = ++memberSyncSeq;
	const device = await loadTeamDevice();
	// Hier statt in jeder Komponente einzeln gelesen: läuft beim App-Start, hält
	// den reaktiven Zustand also auch dann aktuell, wenn niemand die
	// Einstellungen öffnet.
	teamJoin.device = device;
	if (!device) {
		teamJoin.removedFrom = await loadTeamRemovedFrom().catch(() => null);
		return "none";
	}

	let remote: RemoteTeamActivity[];
	// 401: das Team wurde gelöscht oder dieses Mitglied entfernt. Wie eine leere
	// Antwort behandelt - alle Zeilen lösen sich ab, danach wird die
	// Mitgliedschaft vergessen. Jeder andere Fehler ist ein Netz-Aussetzer.
	let membershipGone = false;
	try {
		remote = (await fetchTeamActivities(device.serverUrl, device.token)).activities;
	} catch (e) {
		if (e instanceof ApiError && e.status === 401) {
			remote = [];
			membershipGone = true;
		} else {
			logWarn("Team-Aktivitäten konnten nicht geladen werden", e);
			return "offline";
		}
	}

	let applied = false;
	await withActivitiesLock(async () => {
		if (seq < memberSyncApplied) return;
		// Zwischenzeitlich könnte "Team verlassen" oder ein neuer Beitritt gelaufen
		// sein - eine Antwort zum alten Token darf dann nichts mehr schreiben und
		// erst recht nicht die neue Mitgliedschaft löschen.
		const stillMember = await loadTeamDevice();
		if (!stillMember || stillMember.token !== device.token) return;
		applied = true;
		memberSyncApplied = seq;

		// Eine vom Chef entfernte Zeile nicht verschwinden lassen (report.ts baut
		// nur aus der aktuellen Liste, erfasste Stunden gingen verloren), sondern
		// wie beim Verlassen mit NEUER Id archivieren: dieselbe Server-Id kann
		// nach einem erneuten Beitritt wiederkommen.
		const remoteIds = new Set(remote.map((r) => `${TEAM_ACTIVITY_PREFIX}${r.id}`));
		const gone = new Set(
			app.activities.filter((a) => isJoinedTeamRow(a) && !remoteIds.has(a.id)).map((a) => a.id)
		);
		if (gone.size > 0) await app.detachTeamActivities((a) => isJoinedTeamRow(a) && gone.has(a.id));

		// Tritt ein Chef dem eigenen Team per Link bei, kommt dieselbe Id schon
		// über die eigene Liste - die behält ihre teamId und damit Vorrang, sonst
		// nähme "Team verlassen" dem Chef seine eigenen Team-Stunden mit.
		const ownIds = new Set(app.activities.filter(isOwnTeamRow).map((a) => a.id));
		app.activities = withoutDuplicateIds([
			...app.activities.filter((a) => !isJoinedTeamRow(a)),
			...remote.map((r) => toLocal(r, { name: device.teamName })).filter((a) => !ownIds.has(a.id))
		]);
		await app.persistActivities();

		if (membershipGone) {
			await clearTeamDevice();
			teamJoin.device = null;
			teamJoin.removedFrom = device.teamName;
			await saveTeamRemovedFrom(device.teamName).catch((e) => logWarn("Hinweis auf Rauswurf nicht gespeichert", e));
		}
	});

	if (!applied) return "none";
	return membershipGone ? "removed" : "ok";
}

/**
 * Team verlassen: erst die Zeilen ablösen, dann die Mitgliedschaft vergessen.
 * Andersherum bliebe bei einem Fehler im Ablösen eine Team-Zeile ohne Team
 * stehen, die kein späterer Abgleich mehr aufräumt.
 */
export async function leaveTeam(): Promise<void> {
	const device = await withActivitiesLock(async () => {
		const current = await loadTeamDevice();
		await app.detachTeamActivities(isJoinedTeamRow);
		await clearTeamDevice();
		teamJoin.device = null;
		return current;
	});
	if (!device) return;
	// Ausserhalb des Locks und ohne darauf zu warten: eine hängende Anfrage soll
	// weder Abgleiche noch den Knopf aufhalten. Offline oder schon entfernt:
	// lokal ist man trotzdem draussen, der Chef sieht das Mitglied dann weiter,
	// bis er es entfernt.
	void leaveTeamOnServer(device.serverUrl, device.token).catch((e) =>
		logWarn("Austritt beim Team nicht gemeldet", e)
	);
}

/** Den Hinweis "nicht mehr im Team" wegklicken. */
export async function dismissTeamRemoved(): Promise<void> {
	teamJoin.removedFrom = null;
	await saveTeamRemovedFrom(null).catch((e) => logWarn("Hinweis auf Rauswurf nicht gelöscht", e));
}

/**
 * Die selbst verwalteten Team-Listen des Chefs in app.activities spiegeln.
 *
 * Ohne das taucht eine Team-Aktivität in der eigenen Zeiterfassung (Auswahl,
 * Bericht, Ausblenden) nie auf - der Chef sieht sie nur in der separaten
 * Verwaltung im Aktivitäten-Tab, nie beim eigenen Timer. Holt alle Teams
 * parallel und schreibt app.activities genau einmal.
 *
 * Ein Team, das es nicht mehr gibt (gelöscht, oder dieses Konto ist dort
 * nicht mehr Verwalter), taucht in chefTeams.teams nicht mehr auf - dessen
 * Zeilen lösen sich ab wie eine einzeln entfernte.
 *
 * Offline bleibt der zuletzt gespiegelte Stand unverändert stehen.
 */
export async function syncOwnedTeamActivities(): Promise<void> {
	if (!account.linked) return;
	const seq = ++ownedSyncSeq;
	// Ohne Serverantwort ist chefTeams.teams leer oder veraltet - jede Team-Zeile
	// sähe dann wie ein gelöschtes Team aus und würde abgelöst.
	if (!(await chefTeams.loadTeams())) return;

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
				logWarn(`Aktivitäten von Team „${team.name}“ konnten nicht geladen werden`, e);
				return null;
			}
		}),
		...[...deletedTeamIds].map((teamId) =>
			Promise.resolve({ team: { id: teamId, name: "" }, remote: [] as TeamActivity[] })
		)
	]);

	await withActivitiesLock(async () => {
		if (seq < ownedSyncApplied) return;
		ownedSyncApplied = seq;
		const loaded = results.filter((r): r is NonNullable<typeof r> => r !== null);
		const isOwnedRowOf = (teamIds: Set<string>) => (a: Activity) =>
			a.teamOwned === true && a.teamId !== undefined && teamIds.has(a.teamId);

		const gone = new Set<string>();
		for (const { team, remote } of loaded) {
			const remoteIds = new Set(remote.map((r) => `${TEAM_ACTIVITY_PREFIX}${r.id}`));
			for (const a of app.activities) {
				if (a.teamOwned && a.teamId === team.id && !remoteIds.has(a.id)) gone.add(a.id);
			}
		}
		const refreshed = new Set(loaded.map((r) => r.team.id));
		if (gone.size > 0) {
			await app.detachTeamActivities((a) => isOwnedRowOf(refreshed)(a) && gone.has(a.id));
		}

		// Eigene zuerst: kollidiert eine beigetretene Zeile (Chef im eigenen Team)
		// mit derselben Id, gewinnt die eigene samt teamId.
		const fresh = loaded.flatMap(({ team, remote }) => remote.map((r) => toLocal(r, team)));
		const freshIds = new Set(fresh.map((a) => a.id));
		app.activities = withoutDuplicateIds([
			...fresh,
			...app.activities.filter(
				(a) => !isOwnedRowOf(refreshed)(a) && !(isJoinedTeamRow(a) && freshIds.has(a.id))
			)
		]);
		await app.persistActivities();
	});
}
