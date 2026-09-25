// Team beitreten: Vorschau und Beitritt, samt Ablegen des Team-Tokens. Von der
// Web-Route UND dem Desktop-Dialog benutzt, damit beide dasselbe tun.
import { joinTeam as apiJoinTeam, leaveTeamOnServer, previewTeamInvite } from "./api";
import { app } from "../app.svelte";
import { loadTeamDevice, saveTeamDevice, saveTeamRemovedFrom, type TeamDeviceInfo } from "../store";
import { teamJoin } from "./state.svelte";
import { syncTeamActivities } from "./activities";
import { logInfo, logWarn } from "../log";

export function previewTeam(serverUrl: string, code: string): Promise<{ teamName: string }> {
	return previewTeamInvite(serverUrl, code);
}

/** Beitreten und das Team-Token ablegen - danach kennt dieses Gerät sein Team. */
export async function completeTeamJoin(
	serverUrl: string,
	code: string,
	name: string,
	email?: string
): Promise<TeamDeviceInfo> {
	const previous = await loadTeamDevice().catch(() => null);
	const joined = await apiJoinTeam(serverUrl, code, name, email);
	const info: TeamDeviceInfo = {
		teamMemberId: joined.teamMemberId,
		token: joined.token,
		teamName: joined.teamName,
		serverUrl
	};
	await saveTeamDevice(info);
	teamJoin.device = info;
	teamJoin.removedFrom = null;
	void saveTeamRemovedFrom(null).catch(() => {});
	logInfo(`Team beigetreten: ${joined.teamName}`);
	// Ein Gerät ist in höchstens einem Team: das alte erfährt vom Wechsel, sonst
	// stünde man dort jeden Monat als "kein Bericht" in der Liste.
	if (previous && previous.token !== info.token) {
		void leaveTeamOnServer(previous.serverUrl, previous.token).catch((e) =>
			logWarn("Austritt beim vorigen Team nicht gemeldet", e)
		);
	}

	// Sonst sieht ein bereits laufendes Gerät die gemeinsamen Aktivitäten erst
	// nach dem nächsten Start oder einem manuellen Aktualisieren unter Einstellungen → Team.
	// Ein Fehlschlag hier darf den erfolgreichen Beitritt nicht zurücknehmen.
	// Die Web-Route läuft ohne App-Start: ohne geladene Aktivitäten würde der
	// Abgleich die persönlichen mit der Team-Liste überschreiben.
	try {
		if (!app.loaded && !(await app.init())) {
			logWarn("Team-Aktivitäten nach Beitritt nicht geladen: App-Start fehlgeschlagen");
			return info;
		}
		await syncTeamActivities();
	} catch (e) {
		logWarn("Team-Aktivitäten nach Beitritt nicht geladen", e);
	}

	return info;
}
