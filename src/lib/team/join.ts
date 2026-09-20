// Team beitreten: Vorschau und Beitritt, samt Ablegen des Team-Tokens. Von der
// Web-Route UND dem Desktop-Dialog benutzt, damit beide dasselbe tun.
import { joinTeam as apiJoinTeam, previewTeamInvite } from "./api";
import { app } from "../app.svelte";
import { saveTeamDevice, type TeamDeviceInfo } from "../store";
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
	const joined = await apiJoinTeam(serverUrl, code, name, email);
	const info: TeamDeviceInfo = {
		teamMemberId: joined.teamMemberId,
		token: joined.token,
		teamName: joined.teamName,
		serverUrl
	};
	await saveTeamDevice(info);
	teamJoin.device = info;
	logInfo(`Team beigetreten: ${joined.teamName}`);

	// Sonst sieht ein bereits laufendes Gerät die gemeinsamen Aktivitäten erst
	// nach dem nächsten Start oder einem manuellen Aktualisieren im Bericht-Tab.
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
