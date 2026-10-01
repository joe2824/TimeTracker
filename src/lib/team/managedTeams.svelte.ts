// Reaktiver Zustand rund um die von der Leitung verwalteten Teams - geteilt zwischen
// dem Team-Tab (Übersicht, Link kopieren) und den Einstellungen (Anlegen,
// Link erzeugen), damit beide dieselbe Auswahl und denselben Link-Stand
// sehen, ohne dass ein Speichern im einen Tab im anderen veraltet aussieht.
import { account } from "../sync/account.svelte";
import type { TeamAdminInfo, TeamInfo, TeamInvite } from "../sync/api";
import { errorText, logWarn } from "../log";
import { copyText } from "../ui/clipboard";
import { toast } from "svelte-sonner";

interface TeamScopedLoadOptions<T> {
	fetch: (teamId: string) => Promise<T>;
	/** Nur aufgerufen, solange das Team noch ausgewählt ist. */
	apply: (value: T) => void;
	isSelected: (teamId: string) => boolean;
	setLoading: (on: boolean) => void;
	failText: string;
}

/**
 * Ein je Team geladener Wert (Beitritts-Link, Verwalter, Verwalter-Link).
 * TeamPanel und TeamTab laden bei jedem Teamwechsel beide (bits-ui hängt alle
 * Tabs gleichzeitig ein): ein laufender Abruf für dasselbe Team wird deshalb
 * geteilt, und nur der jüngste Abruf darf die Ladeanzeige beenden.
 */
class TeamScopedLoad<T> {
	#opts: TeamScopedLoadOptions<T>;
	#request = new Map<string, number>();
	#inFlight = new Map<string, { id: number; run: Promise<boolean> }>();
	#spinnerRun = 0;

	constructor(opts: TeamScopedLoadOptions<T>) {
		this.#opts = opts;
	}

	/** true, wenn die Antwort ankam und noch galt. */
	load(teamId: string): Promise<boolean> {
		const current = this.#request.get(teamId) ?? 0;
		const shared = this.#inFlight.get(teamId);
		if (shared && shared.id === current) {
			if (!this.#opts.isSelected(teamId)) return shared.run;
			// Wieder ausgewählt, während der Abruf noch läuft: eigene Marke, sonst
			// beendete ein älterer Abruf für ein anderes Team die Ladeanzeige.
			const spinner = ++this.#spinnerRun;
			this.#opts.setLoading(true);
			return shared.run.finally(() => {
				if (spinner === this.#spinnerRun) this.#opts.setLoading(false);
			});
		}

		const id = current + 1;
		this.#request.set(teamId, id);
		const opts = this.#opts;
		const spinner = opts.isSelected(teamId) ? ++this.#spinnerRun : null;
		if (spinner !== null) opts.setLoading(true);
		const run = (async () => {
			try {
				const value = await opts.fetch(teamId);
				if (this.#request.get(teamId) !== id) return false;
				if (opts.isSelected(teamId)) opts.apply(value);
				return true;
			} catch (e) {
				if (this.#request.get(teamId) !== id) return false;
				logWarn(opts.failText, e);
				toast.error(`${opts.failText}: ${errorText(e)}`);
				return false;
			} finally {
				if (spinner !== null && spinner === this.#spinnerRun) opts.setLoading(false);
			}
		})();
		this.#inFlight.set(teamId, { id, run });
		void run.finally(() => {
			if (this.#inFlight.get(teamId)?.run === run) this.#inFlight.delete(teamId);
		});
		return run;
	}

	/** Ein anderswo gesetzter Stand (neu erzeugter Link) ist aktueller als jeder noch laufende Abruf. */
	supersede(teamId: string): void {
		this.#request.set(teamId, (this.#request.get(teamId) ?? 0) + 1);
	}
}

class ManagedTeamsState {
	teams = $state<TeamInfo[]>([]);
	#selectedTeamId = $state<string | undefined>(undefined);
	teamsLoading = $state(false);
	/** Letzter Ladeversuch ohne Antwort - die Team-Ansicht zeigt dann einen Hinweis statt "kein Team". */
	teamsLoadFailed = $state(false);
	invite = $state<TeamInvite | null>(null);
	inviteLoading = $state(false);
	rotating = $state(false);
	creating = $state(false);

	// Verwalter des ausgewaehlten Teams - nur die Leitung darf sie einladen oder entfernen
	// oder den Verwalter-Link erzeugen (siehe isOwner), sehen darf sie jeder
	// mit Zugang.
	admins = $state<TeamAdminInfo[]>([]);
	adminsLoading = $state(false);
	adminInvite = $state<TeamInvite | null>(null);
	adminInviteLoading = $state(false);
	rotatingAdminInvite = $state(false);

	/** Beim Abmelden: Teams, Links und Verwalter gehören dem alten Konto. */
	reset(): void {
		this.#teamsRequest++;
		this.#teamsInFlight = null;
		this.teams = [];
		this.selectedTeamId = undefined;
		this.teamsLoading = false;
		this.teamsLoadFailed = false;
		this.invite = null;
		this.admins = [];
		this.adminInvite = null;
	}

	get selectedTeamId(): string | undefined {
		return this.#selectedTeamId;
	}

	/** Ein Wechsel verwirft Link und Verwalter des bisherigen Teams, bis die des neuen geladen sind. */
	set selectedTeamId(id: string | undefined) {
		if (id === this.#selectedTeamId) return;
		this.#selectedTeamId = id;
		this.invite = null;
		this.admins = [];
		this.adminInvite = null;
	}

	get selectedTeam(): TeamInfo | null {
		return this.teams.find((t) => t.id === this.selectedTeamId) ?? null;
	}

	/** Leitung statt nur Verwalter - entscheidet ueber Loeschen, Verwalter-Link, Besitzuebergabe. */
	get isOwner(): boolean {
		return this.selectedTeam?.role !== "admin";
	}

	get inviteUrl(): string | null {
		return this.invite ? `${account.serverUrl}/team/join/${this.invite.code}` : null;
	}

	async copyInviteUrl(): Promise<void> {
		if (this.inviteUrl) await copyText(this.inviteUrl, "Link kopiert.");
	}

	// TeamPanel, ActivitiesPanel und TeamTab rufen loadTeams() unabhaengig
	// voneinander beim Mounten auf (bits-ui haengt alle Tabs gleichzeitig ein) -
	// ohne Zwischenspeicher waeren das bei jedem Start mehrere identische
	// Anfragen. Ein laufender Aufruf wird deshalb geteilt statt verdoppelt.
	#teamsInFlight: Promise<boolean> | null = null;
	/** Zaehlt jeden Aufruf durch, damit eine veraltete Antwort (z.B. vor einem
	 *  createTeam) das inzwischen aktuellere teams nicht ueberschreibt. */
	#teamsRequest = 0;
	#teamsInFlightId = 0;

	/** false, wenn teams nicht der Serverstand ist (keine Antwort, oder create/deleteTeam kam dazwischen) - dann kein Beleg dafür, welche Teams es gibt. */
	async loadTeams(): Promise<boolean> {
		if (!account.linked) return false;
		// Nur eine noch aktuelle Anfrage teilen: eine von create/deleteTeam
		// überholte liefert false, und wer danach fragt, braucht den Serverstand.
		if (this.#teamsInFlight && this.#teamsInFlightId === this.#teamsRequest) {
			return this.#teamsInFlight;
		}
		const requestId = ++this.#teamsRequest;
		this.#teamsInFlightId = requestId;
		this.teamsLoading = true;
		const run = (async () => {
			try {
				const teams = await account.listTeams();
				if (requestId !== this.#teamsRequest) return false;
				this.teams = teams;
				this.teamsLoadFailed = false;
				if (!this.selectedTeamId || !this.teams.some((t) => t.id === this.selectedTeamId)) {
					this.selectedTeamId = this.teams[0]?.id;
				}
				return true;
			} catch (e) {
				if (requestId !== this.#teamsRequest) return false;
				// Kein Toast: jeder Aufruf kommt aus dem Hintergrund (Öffnen einer
				// Ansicht, Abgleich beim Start) - offline träfe er auch jeden ohne Team.
				logWarn("Teams konnten nicht geladen werden", e);
				this.teamsLoadFailed = true;
				return false;
			} finally {
				if (requestId === this.#teamsRequest) this.teamsLoading = false;
			}
		})();
		this.#teamsInFlight = run;
		try {
			return await run;
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
		this.#forgetTeam(teamId);
	}

	/** Als Verwalter die Verwaltung des ausgewählten Teams abgeben - danach ist es aus der Liste verschwunden. */
	async leaveAsAdmin(): Promise<void> {
		const teamId = this.selectedTeamId;
		if (!teamId) return;
		await account.leaveTeamAsAdmin(teamId);
		this.#forgetTeam(teamId);
	}

	#forgetTeam(teamId: string): void {
		this.#teamsRequest++;
		this.teams = this.teams.filter((t) => t.id !== teamId);
		// Der bisherige Link, die Verwalter und der Verwalter-Link gehoerten
		// womoeglich dem geloeschten Team - lieber neu laden lassen (siehe
		// loadInvite/loadAdmins/loadAdminInvite-Aufrufer) als versehentlich unter
		// dem naechsten ausgewaehlten Team stehenlassen.
		this.invite = null;
		this.admins = [];
		this.adminInvite = null;
		if (this.selectedTeamId === teamId) this.selectedTeamId = this.teams[0]?.id;
	}

	#invites = new TeamScopedLoad<TeamInvite | null>({
		fetch: (teamId) => account.getTeamInvite(teamId),
		apply: (inv) => (this.invite = inv),
		isSelected: (teamId) => teamId === this.selectedTeamId,
		setLoading: (on) => (this.inviteLoading = on),
		failText: "Team konnte nicht geladen werden"
	});

	/**
	 * Gibt zurück, ob der Abruf wirklich durchkam - ein Fehlschlag ist kein
	 * "es gibt keinen Link": wer daraus automatisch einen neuen erzeugt (siehe
	 * TeamTab), würde sonst bei einem blossen Netzwerk-Hänger einen echten,
	 * schon verteilten Link ungültig machen.
	 */
	loadInvite(teamId: string): Promise<boolean> {
		return this.#invites.load(teamId);
	}

	rotateInvite(): Promise<void> {
		return this.#rotate(
			"rotating",
			(teamId) => account.rotateTeamInvite(teamId),
			this.#invites,
			(inv) => (this.invite = inv)
		);
	}

	/** Einen Link des ausgewählten Teams neu erzeugen. */
	async #rotate(
		flag: "rotating" | "rotatingAdminInvite",
		rotate: (teamId: string) => Promise<TeamInvite>,
		loads: TeamScopedLoad<TeamInvite | null>,
		apply: (inv: TeamInvite) => void
	): Promise<void> {
		const teamId = this.selectedTeamId;
		if (!teamId || this[flag]) return;
		this[flag] = true;
		try {
			const inv = await rotate(teamId);
			loads.supersede(teamId);
			if (teamId === this.selectedTeamId) apply(inv);
		} finally {
			this[flag] = false;
		}
	}

	// ---------- Verwalter ----------

	#admins = new TeamScopedLoad<TeamAdminInfo[]>({
		fetch: (teamId) => account.listTeamAdmins(teamId),
		apply: (admins) => (this.admins = admins),
		isSelected: (teamId) => teamId === this.selectedTeamId,
		setLoading: (on) => (this.adminsLoading = on),
		failText: "Verwalter konnten nicht geladen werden"
	});

	async loadAdmins(teamId: string): Promise<void> {
		await this.#admins.load(teamId);
	}

	async removeAdmin(userId: string): Promise<void> {
		const teamId = this.selectedTeamId;
		if (!teamId) return;
		await account.removeTeamAdmin(teamId, userId);
		// Ein vorher losgeschickter Abruf brächte sonst den alten Stand zurück.
		this.#admins.supersede(teamId);
		this.#adminInvites.supersede(teamId);
		if (teamId !== this.selectedTeamId) return; // Auswahl wechselte waehrend des Requests
		this.admins = this.admins.filter((a) => a.userId !== userId);
		// Der Server widerruft beim Aussetzen eines Verwalters auch den bisherigen
		// Verwalter-Link (siehe removeTeamAdmin) - der hier gehaltene Stand waere
		// sonst ein toter Link, der weiter angezeigt wuerde.
		this.adminInvite = null;
	}

	get adminInviteUrl(): string | null {
		return this.adminInvite ? `${account.serverUrl}/team/admin/${this.adminInvite.code}` : null;
	}

	async copyAdminInviteUrl(): Promise<void> {
		if (this.adminInviteUrl) await copyText(this.adminInviteUrl, "Link kopiert.");
	}

	#adminInvites = new TeamScopedLoad<TeamInvite | null>({
		fetch: (teamId) => account.getAdminInvite(teamId),
		apply: (inv) => (this.adminInvite = inv),
		isSelected: (teamId) => teamId === this.selectedTeamId,
		setLoading: (on) => (this.adminInviteLoading = on),
		failText: "Verwalter-Link konnte nicht geladen werden"
	});

	async loadAdminInvite(teamId: string): Promise<void> {
		await this.#adminInvites.load(teamId);
	}

	rotateAdminInvite(): Promise<void> {
		return this.#rotate(
			"rotatingAdminInvite",
			(teamId) => account.rotateAdminInvite(teamId),
			this.#adminInvites,
			(inv) => (this.adminInvite = inv)
		);
	}

	/**
	 * Besitz übergeben - das Ziel muss bereits Verwalter sein. Lädt die
	 * Teamliste danach neu: die eigene Rolle für dieses Team kippt von owner
	 * auf admin, und nur listTeams() liefert das aktuell.
	 */
	async transferOwnership(newOwnerUserId: string): Promise<void> {
		const teamId = this.selectedTeamId;
		if (!teamId) return;
		await account.transferTeamOwnership(teamId, newOwnerUserId);
		this.#admins.supersede(teamId);
		this.#adminInvites.supersede(teamId);
		this.admins = [];
		this.adminInvite = null;
		await this.loadTeams();
	}
}

export const managedTeams = new ManagedTeamsState();
account.addLogoutHook(() => managedTeams.reset());
