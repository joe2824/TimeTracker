// Team beitreten: Vorschau und Beitritt, samt Ablegen des Team-Tokens. Von der
// Web-Route UND dem Desktop-Dialog benutzt, damit beide dasselbe tun.
import { joinTeam as apiJoinTeam, previewTeamInvite } from "./api";
import { saveTeamDevice, type TeamDeviceInfo } from "../store";
import { teamJoin } from "./state.svelte";
import { logInfo } from "../log";

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
	return info;
}
