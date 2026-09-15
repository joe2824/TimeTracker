// Reaktiver Zustand rund um die vom Chef verwalteten Teams - geteilt zwischen
// dem Team-Tab (Übersicht, Link kopieren) und den Einstellungen (Anlegen,
// Link erzeugen), damit beide dieselbe Auswahl und denselben Link-Stand
// sehen, ohne dass ein Speichern im einen Tab im anderen veraltet aussieht.
import { account } from "../sync/account.svelte";
import type { TeamInfo, TeamInvite } from "../sync/api";

class ChefTeamsState {
	teams = $state<TeamInfo[]>([]);
	selectedTeamId = $state<string | undefined>(undefined);
	teamsLoading = $state(false);
	invite = $state<TeamInvite | null>(null);
	inviteLoading = $state(false);
	rotating = $state(false);
	creating = $state(false);

	get selectedTeam(): TeamInfo | null {
		return this.teams.find((t) => t.id === this.selectedTeamId) ?? null;
	}

	async loadTeams(): Promise<void> {
		if (!account.linked) return;
		this.teamsLoading = true;
		try {
			this.teams = await account.listTeams();
			if (!this.selectedTeamId || !this.teams.some((t) => t.id === this.selectedTeamId)) {
				this.selectedTeamId = this.teams[0]?.id;
			}
		} finally {
			this.teamsLoading = false;
		}
	}

	async createTeam(name: string): Promise<TeamInfo> {
		this.creating = true;
		try {
			const team = await account.createTeam(name);
			this.teams = [team, ...this.teams];
			this.selectedTeamId = team.id;
			return team;
		} finally {
			this.creating = false;
		}
	}

	async loadInvite(teamId: string): Promise<void> {
		this.inviteLoading = true;
		try {
			const inv = await account.getTeamInvite(teamId);
			if (teamId === this.selectedTeamId) this.invite = inv;
		} finally {
			if (teamId === this.selectedTeamId) this.inviteLoading = false;
		}
	}

	async rotateInvite(): Promise<void> {
		const teamId = this.selectedTeamId;
		if (!teamId || this.rotating) return;
		this.rotating = true;
		try {
			const inv = await account.rotateTeamInvite(teamId);
			if (teamId === this.selectedTeamId) this.invite = inv;
		} finally {
			this.rotating = false;
		}
	}
}

export const chefTeams = new ChefTeamsState();
