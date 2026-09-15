// Reaktiver Zustand rund um die vom Chef verwalteten Teams - geteilt zwischen
// dem Team-Tab (Übersicht, Link kopieren) und den Einstellungen (Anlegen,
// Link erzeugen), damit beide dieselbe Auswahl und denselben Link-Stand
// sehen, ohne dass ein Speichern im einen Tab im anderen veraltet aussieht.
import { account } from "../sync/account.svelte";
import type { TeamInfo, TeamInvite } from "../sync/api";
import { errorText, logWarn } from "../log";
import { toast } from "svelte-sonner";

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

	get inviteUrl(): string | null {
		return this.invite ? `${account.serverUrl}/team/join/${this.invite.code}` : null;
	}

	async copyInviteUrl(): Promise<void> {
		const url = this.inviteUrl;
		if (!url) return;
		try {
			await navigator.clipboard.writeText(url);
			toast.success("Link kopiert.");
		} catch {
			toast.error("Kopieren nicht möglich – bitte manuell kopieren.");
		}
	}

	// TeamPanel, ActivitiesPanel und TeamTab rufen loadTeams() unabhaengig
	// voneinander beim Mounten auf (bits-ui haengt alle Tabs gleichzeitig ein) -
	// ohne Zwischenspeicher waeren das bei jedem Start mehrere identische
	// Anfragen. Ein laufender Aufruf wird deshalb geteilt statt verdoppelt.
	#teamsInFlight: Promise<void> | null = null;
	/** Zaehlt jeden Aufruf durch, damit eine veraltete Antwort (z.B. vor einem
	 *  createTeam) das inzwischen aktuellere teams nicht ueberschreibt. */
	#teamsRequest = 0;

	async loadTeams(): Promise<void> {
		if (!account.linked) return;
		if (this.#teamsInFlight) return this.#teamsInFlight;
		const requestId = ++this.#teamsRequest;
		this.teamsLoading = true;
		const run = (async () => {
			try {
				const teams = await account.listTeams();
				if (requestId !== this.#teamsRequest) return;
				this.teams = teams;
				if (!this.selectedTeamId || !this.teams.some((t) => t.id === this.selectedTeamId)) {
					this.selectedTeamId = this.teams[0]?.id;
				}
			} catch (e) {
				if (requestId !== this.#teamsRequest) return;
				logWarn("Teams konnten nicht geladen werden", e);
				toast.error(`Teams konnten nicht geladen werden: ${errorText(e)}`);
			} finally {
				if (requestId === this.#teamsRequest) this.teamsLoading = false;
			}
		})();
		this.#teamsInFlight = run;
		try {
			await run;
		} finally {
			if (this.#teamsInFlight === run) this.#teamsInFlight = null;
		}
	}

	async createTeam(name: string): Promise<TeamInfo> {
		this.creating = true;
		try {
			const team = await account.createTeam(name);
			this.#teamsRequest++; // eine noch laufende loadTeams()-Antwort veraltet damit sofort
			this.teams = [team, ...this.teams];
			this.selectedTeamId = team.id;
			return team;
		} finally {
			this.creating = false;
		}
	}

	async deleteTeam(teamId: string): Promise<void> {
		await account.deleteTeam(teamId);
		this.#teamsRequest++;
		this.teams = this.teams.filter((t) => t.id !== teamId);
		// Der bisherige Link gehoerte womoeglich dem geloeschten Team - lieber neu
		// laden lassen (siehe loadInvite-Aufrufer) als versehentlich stehenlassen.
		this.invite = null;
		if (this.selectedTeamId === teamId) this.selectedTeamId = this.teams[0]?.id;
	}

	/** Zaehlt wie #teamsRequest, aber je Team-Id - zwei gleichzeitige Aufrufe
	 *  fuer DASSELBE Team liessen sich sonst nicht auseinanderhalten (anders
	 *  als am Vergleich mit der aktuellen Auswahl, der zwei parallele Aufrufe
	 *  fuer das gleiche Team nicht erkennt). */
	#inviteRequest = new Map<string, number>();

	async loadInvite(teamId: string): Promise<void> {
		const requestId = (this.#inviteRequest.get(teamId) ?? 0) + 1;
		this.#inviteRequest.set(teamId, requestId);
		if (teamId === this.selectedTeamId) this.inviteLoading = true;
		try {
			const inv = await account.getTeamInvite(teamId);
			if (this.#inviteRequest.get(teamId) !== requestId) return;
			if (teamId === this.selectedTeamId) this.invite = inv;
		} catch (e) {
			if (this.#inviteRequest.get(teamId) !== requestId) return;
			logWarn("Team konnte nicht geladen werden", e);
			toast.error(`Team konnte nicht geladen werden: ${errorText(e)}`);
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
			this.#inviteRequest.set(teamId, (this.#inviteRequest.get(teamId) ?? 0) + 1);
			if (teamId === this.selectedTeamId) this.invite = inv;
		} finally {
			this.rotating = false;
		}
	}
}

export const chefTeams = new ChefTeamsState();
