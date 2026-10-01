// managedTeams: geteilter Zustand zwischen Team-Tab, Einstellungen und dem
// Aktivitäten-Tab - vor allem die Renn- und Fehlerbehandlung, die hier schon
// einmal stillschweigend verlorenging.
import { beforeEach, describe, expect, it, vi } from "vitest";

const toastError = vi.fn();
vi.mock("svelte-sonner", () => ({
	toast: Object.assign(() => {}, { error: toastError, success: vi.fn(), info: vi.fn(), warning: vi.fn() })
}));

const accountMock = vi.hoisted(() => ({
	addLogoutHook: () => {},
	linked: true,
	listTeams: vi.fn(),
	createTeam: vi.fn(),
	deleteTeam: vi.fn(),
	getTeamInvite: vi.fn(),
	rotateTeamInvite: vi.fn(),
	listTeamAdmins: vi.fn(),
	removeTeamAdmin: vi.fn(),
	leaveTeamAsAdmin: vi.fn(),
	getAdminInvite: vi.fn(),
	rotateAdminInvite: vi.fn(),
	transferTeamOwnership: vi.fn(),
	serverUrl: "https://tt.example.de"
}));
vi.mock("../sync/account.svelte", () => ({ account: accountMock }));

const { managedTeams } = await import("./managedTeams.svelte");

const TEAM_A = { id: "t1", name: "A", ownerUserId: "u1", createdAt: 1 };
const TEAM_B = { id: "t2", name: "B", ownerUserId: "u1", createdAt: 1 };
const ADMIN_ANNA = { userId: "a1", displayName: "Anna Meier", email: "anna@firma.de", createdAt: 1 };

beforeEach(() => {
	accountMock.linked = true;
	accountMock.listTeams.mockReset();
	accountMock.createTeam.mockReset();
	accountMock.deleteTeam.mockReset();
	accountMock.getTeamInvite.mockReset();
	accountMock.rotateTeamInvite.mockReset();
	accountMock.listTeamAdmins.mockReset();
	accountMock.removeTeamAdmin.mockReset();
	accountMock.leaveTeamAsAdmin.mockReset();
	accountMock.getAdminInvite.mockReset();
	accountMock.rotateAdminInvite.mockReset();
	accountMock.transferTeamOwnership.mockReset();
	toastError.mockReset();
	managedTeams.teams = [];
	managedTeams.selectedTeamId = undefined;
	managedTeams.invite = null;
	managedTeams.admins = [];
	managedTeams.adminInvite = null;
	managedTeams.inviteLoading = false;
	managedTeams.adminsLoading = false;
	managedTeams.adminInviteLoading = false;
});

const invite = (teamId: string, code: string) => ({ code, teamId, createdAt: 1, expiresAt: null, revokedAt: null });

describe("loadTeams", () => {
	it("teilt einen laufenden Aufruf statt ihn zu verdoppeln", async () => {
		let resolve!: (v: typeof TEAM_A[]) => void;
		accountMock.listTeams.mockReturnValue(new Promise((r) => (resolve = r)));

		const first = managedTeams.loadTeams();
		const second = managedTeams.loadTeams();
		resolve([TEAM_A]);
		await Promise.all([first, second]);

		expect(accountMock.listTeams).toHaveBeenCalledTimes(1);
		expect(managedTeams.teams).toEqual([TEAM_A]);
	});

	it("meldet einen Fehlschlag über teamsLoadFailed statt per Toast und reicht die Ablehnung nicht durch", async () => {
		// Jeder Aufruf kommt aus dem Hintergrund - offline träfe ein Toast auch jeden ohne Team.
		accountMock.listTeams.mockRejectedValue(new Error("Netzwerk weg"));
		await expect(managedTeams.loadTeams()).resolves.toBe(false);
		expect(toastError).not.toHaveBeenCalled();
		expect(managedTeams.teamsLoadFailed).toBe(true);

		accountMock.listTeams.mockResolvedValue([]);
		await managedTeams.loadTeams();
		expect(managedTeams.teamsLoadFailed).toBe(false);
	});

	it("eine veraltete Antwort ueberschreibt nicht, was createTeam() inzwischen angelegt hat", async () => {
		let resolve!: (v: typeof TEAM_A[]) => void;
		accountMock.listTeams.mockReturnValue(new Promise((r) => (resolve = r)));
		const stale = managedTeams.loadTeams();

		accountMock.createTeam.mockResolvedValue(TEAM_B);
		await managedTeams.createTeam("B");

		resolve([TEAM_A]); // kommt jetzt erst an, kennt TEAM_B noch nicht

		// false: teams ist jetzt nur lokal fortgeschrieben, kein Serverstand - sonst
		// hielte syncOwnedTeamActivities TEAM_A für gelöscht.
		await expect(stale).resolves.toBe(false);
		expect(managedTeams.teams.some((t) => t.id === TEAM_B.id)).toBe(true);
	});

	it("haengt sich nach deleteTeam() nicht an eine veraltete laufende Anfrage", async () => {
		let resolveStale!: (v: typeof TEAM_A[]) => void;
		accountMock.listTeams.mockReturnValueOnce(new Promise((r) => (resolveStale = r)));
		const stale = managedTeams.loadTeams();

		accountMock.deleteTeam.mockResolvedValue(undefined);
		await managedTeams.deleteTeam(TEAM_B.id);

		accountMock.listTeams.mockResolvedValueOnce([TEAM_A]);
		const fresh = managedTeams.loadTeams();
		resolveStale([TEAM_A, TEAM_B]);

		await expect(fresh).resolves.toBe(true);
		await expect(stale).resolves.toBe(false);
		expect(accountMock.listTeams).toHaveBeenCalledTimes(2);
		expect(managedTeams.teams).toEqual([TEAM_A]);
	});
});

describe("createTeam / deleteTeam", () => {
	it("legt vorn an und waehlt es aus", async () => {
		accountMock.createTeam.mockResolvedValue(TEAM_A);
		const team = await managedTeams.createTeam("A");
		expect(team).toEqual(TEAM_A);
		expect(managedTeams.teams).toEqual([TEAM_A]);
		expect(managedTeams.selectedTeamId).toBe(TEAM_A.id);
	});

	it("entfernt aus der Liste, waehlt bei Bedarf neu und verwirft den alten Link samt Verwaltern", async () => {
		managedTeams.teams = [TEAM_A, TEAM_B];
		managedTeams.selectedTeamId = TEAM_A.id;
		managedTeams.invite = { code: "abc", teamId: TEAM_A.id, createdAt: 1, expiresAt: null, revokedAt: null };
		managedTeams.admins = [ADMIN_ANNA];
		managedTeams.adminInvite = { code: "xyz", teamId: TEAM_A.id, createdAt: 1, expiresAt: null, revokedAt: null };
		accountMock.deleteTeam.mockResolvedValue({ ok: true });

		await managedTeams.deleteTeam(TEAM_A.id);

		expect(managedTeams.teams).toEqual([TEAM_B]);
		expect(managedTeams.selectedTeamId).toBe(TEAM_B.id);
		expect(managedTeams.invite).toBeNull();
		expect(managedTeams.admins).toEqual([]);
		expect(managedTeams.adminInvite).toBeNull();
	});
});

describe("loadInvite", () => {
	it("teilt einen laufenden Abruf fuer dasselbe Team - TeamPanel und TeamTab fragen beide", async () => {
		managedTeams.selectedTeamId = TEAM_A.id;
		let resolve!: (v: unknown) => void;
		accountMock.getTeamInvite.mockReturnValue(new Promise((r) => (resolve = r)));

		const first = managedTeams.loadInvite(TEAM_A.id);
		const second = managedTeams.loadInvite(TEAM_A.id);
		resolve(invite(TEAM_A.id, "abc"));

		await expect(first).resolves.toBe(true);
		await expect(second).resolves.toBe(true);
		expect(accountMock.getTeamInvite).toHaveBeenCalledTimes(1);
		expect(managedTeams.invite?.code).toBe("abc");
		expect(managedTeams.inviteLoading).toBe(false);
	});

	it("eine veraltete Anfrage beendet die Ladeanzeige der laufenden nicht", async () => {
		managedTeams.selectedTeamId = TEAM_A.id;
		let resolveA!: (v: unknown) => void;
		let resolveB!: (v: unknown) => void;
		accountMock.getTeamInvite
			.mockImplementationOnce(() => new Promise((r) => (resolveA = r)))
			.mockImplementationOnce(() => new Promise((r) => (resolveB = r)));

		const a = managedTeams.loadInvite(TEAM_A.id);
		managedTeams.selectedTeamId = TEAM_B.id;
		const b = managedTeams.loadInvite(TEAM_B.id);
		managedTeams.selectedTeamId = TEAM_A.id; // zurueck, waehrend B noch laedt
		resolveA(invite(TEAM_A.id, "alt"));
		await a;

		// Sonst stuende ein Link da, als waere er fertig geladen, obwohl B noch laeuft.
		expect(managedTeams.inviteLoading).toBe(true);
		resolveB(invite(TEAM_B.id, "b"));
		await b;
		expect(managedTeams.inviteLoading).toBe(false);
	});

	it("eine vor rotateInvite() gestartete Antwort ueberschreibt den neuen Link nicht", async () => {
		managedTeams.selectedTeamId = TEAM_A.id;
		let resolveLoad!: (v: unknown) => void;
		accountMock.getTeamInvite.mockReturnValue(new Promise((r) => (resolveLoad = r)));
		accountMock.rotateTeamInvite.mockResolvedValue(invite(TEAM_A.id, "neu"));

		const load = managedTeams.loadInvite(TEAM_A.id);
		await managedTeams.rotateInvite();
		resolveLoad(invite(TEAM_A.id, "alt"));

		await expect(load).resolves.toBe(false);
		expect(managedTeams.invite?.code).toBe("neu");
		expect(managedTeams.inviteLoading).toBe(false);
	});

	it("meldet einen Fehlschlag per Toast und gibt false zurueck, statt einen fehlenden Link vorzutaeuschen", async () => {
		managedTeams.selectedTeamId = TEAM_A.id;
		accountMock.getTeamInvite.mockRejectedValue(new Error("Netzwerk weg"));
		await expect(managedTeams.loadInvite(TEAM_A.id)).resolves.toBe(false);
		expect(toastError).toHaveBeenCalledTimes(1);
	});
});

describe("loadAdmins", () => {
	it("teilt einen laufenden Abruf und haelt die Ladeanzeige bis zur Antwort", async () => {
		managedTeams.selectedTeamId = TEAM_A.id;
		let resolve!: (v: unknown) => void;
		accountMock.listTeamAdmins.mockReturnValue(new Promise((r) => (resolve = r)));

		const first = managedTeams.loadAdmins(TEAM_A.id);
		const second = managedTeams.loadAdmins(TEAM_A.id);
		expect(managedTeams.adminsLoading).toBe(true);
		resolve([ADMIN_ANNA]);
		await Promise.all([first, second]);

		expect(accountMock.listTeamAdmins).toHaveBeenCalledTimes(1);
		expect(managedTeams.admins).toEqual([ADMIN_ANNA]);
		expect(managedTeams.adminsLoading).toBe(false);
	});

	it("eine veraltete Anfrage beendet die Ladeanzeige der laufenden nicht", async () => {
		managedTeams.selectedTeamId = TEAM_A.id;
		let resolveA!: (v: unknown) => void;
		let resolveB!: (v: unknown) => void;
		accountMock.listTeamAdmins
			.mockImplementationOnce(() => new Promise((r) => (resolveA = r)))
			.mockImplementationOnce(() => new Promise((r) => (resolveB = r)));

		const a = managedTeams.loadAdmins(TEAM_A.id);
		managedTeams.selectedTeamId = TEAM_B.id;
		const b = managedTeams.loadAdmins(TEAM_B.id);
		managedTeams.selectedTeamId = TEAM_A.id;
		resolveA([ADMIN_ANNA]);
		await a;

		expect(managedTeams.adminsLoading).toBe(true);
		resolveB([]);
		await b;
		expect(managedTeams.adminsLoading).toBe(false);
	});

	it("meldet einen Fehlschlag per Toast", async () => {
		managedTeams.selectedTeamId = TEAM_A.id;
		accountMock.listTeamAdmins.mockRejectedValue(new Error("Netzwerk weg"));
		await expect(managedTeams.loadAdmins(TEAM_A.id)).resolves.toBeUndefined();
		expect(toastError).toHaveBeenCalledTimes(1);
	});
});

describe("removeAdmin", () => {
	it("entfernt aus der Liste und verwirft den (serverseitig widerrufenen) Verwalter-Link", async () => {
		managedTeams.selectedTeamId = TEAM_A.id;
		managedTeams.admins = [ADMIN_ANNA];
		managedTeams.adminInvite = { code: "xyz", teamId: TEAM_A.id, createdAt: 1, expiresAt: null, revokedAt: null };
		accountMock.removeTeamAdmin.mockResolvedValue(undefined);

		await managedTeams.removeAdmin(ADMIN_ANNA.userId);

		expect(managedTeams.admins).toEqual([]);
		expect(managedTeams.adminInvite).toBeNull();
	});

	it("wendet eine veraltete Antwort nicht mehr auf ein inzwischen anderes ausgewaehltes Team an", async () => {
		managedTeams.selectedTeamId = TEAM_A.id;
		managedTeams.admins = [ADMIN_ANNA];
		managedTeams.adminInvite = { code: "xyz", teamId: TEAM_A.id, createdAt: 1, expiresAt: null, revokedAt: null };
		let resolveRemove!: () => void;
		accountMock.removeTeamAdmin.mockReturnValue(new Promise<void>((r) => (resolveRemove = r)));

		const remove = managedTeams.removeAdmin(ADMIN_ANNA.userId);
		managedTeams.selectedTeamId = TEAM_B.id; // Chef wechselt das Team, waehrend der Request noch laeuft
		// Inzwischen geladener Stand von B.
		managedTeams.admins = [ADMIN_ANNA];
		managedTeams.adminInvite = invite(TEAM_B.id, "b");
		resolveRemove();
		await remove;

		expect(managedTeams.admins).toEqual([ADMIN_ANNA]);
		expect(managedTeams.adminInvite?.code).toBe("b");
	});
});

describe("loadAdminInvite", () => {
	it("eine veraltete Anfrage beendet die Ladeanzeige der laufenden nicht", async () => {
		managedTeams.selectedTeamId = TEAM_A.id;
		let resolveA!: (v: unknown) => void;
		let resolveB!: (v: unknown) => void;
		accountMock.getAdminInvite
			.mockImplementationOnce(() => new Promise((r) => (resolveA = r)))
			.mockImplementationOnce(() => new Promise((r) => (resolveB = r)));

		const a = managedTeams.loadAdminInvite(TEAM_A.id);
		managedTeams.selectedTeamId = TEAM_B.id;
		const b = managedTeams.loadAdminInvite(TEAM_B.id);
		managedTeams.selectedTeamId = TEAM_A.id;
		resolveA(invite(TEAM_A.id, "alt"));
		await a;

		expect(managedTeams.adminInviteLoading).toBe(true);
		resolveB(invite(TEAM_B.id, "b"));
		await b;
		expect(managedTeams.adminInviteLoading).toBe(false);
	});

	it("eine vor rotateAdminInvite() gestartete Antwort ueberschreibt den neuen Link nicht", async () => {
		managedTeams.selectedTeamId = TEAM_A.id;
		let resolveLoad!: (v: unknown) => void;
		accountMock.getAdminInvite.mockReturnValue(new Promise((r) => (resolveLoad = r)));
		accountMock.rotateAdminInvite.mockResolvedValue(invite(TEAM_A.id, "neu"));

		const load = managedTeams.loadAdminInvite(TEAM_A.id);
		await managedTeams.rotateAdminInvite();
		resolveLoad(invite(TEAM_A.id, "alt"));
		await load;

		expect(managedTeams.adminInvite?.code).toBe("neu");
	});

	it("meldet einen Fehlschlag per Toast", async () => {
		managedTeams.selectedTeamId = TEAM_A.id;
		accountMock.getAdminInvite.mockRejectedValue(new Error("Netzwerk weg"));
		await expect(managedTeams.loadAdminInvite(TEAM_A.id)).resolves.toBeUndefined();
		expect(toastError).toHaveBeenCalledTimes(1);
	});
});

describe("rotateAdminInvite", () => {
	it("ersetzt den Verwalter-Link des ausgewaehlten Teams", async () => {
		managedTeams.selectedTeamId = TEAM_A.id;
		const inv = { code: "neu", teamId: TEAM_A.id, createdAt: 2, expiresAt: null, revokedAt: null };
		accountMock.rotateAdminInvite.mockResolvedValue(inv);

		await managedTeams.rotateAdminInvite();

		expect(managedTeams.adminInvite).toEqual(inv);
		expect(managedTeams.rotatingAdminInvite).toBe(false);
	});
});

describe("transferOwnership", () => {
	it("verwirft Verwalter und Verwalter-Link und laedt die Teamliste neu (die eigene Rolle kippt)", async () => {
		managedTeams.teams = [TEAM_A];
		managedTeams.selectedTeamId = TEAM_A.id;
		managedTeams.admins = [ADMIN_ANNA];
		managedTeams.adminInvite = { code: "xyz", teamId: TEAM_A.id, createdAt: 1, expiresAt: null, revokedAt: null };
		accountMock.transferTeamOwnership.mockResolvedValue(undefined);
		accountMock.listTeams.mockResolvedValue([{ ...TEAM_A, role: "admin" }]);

		await managedTeams.transferOwnership(ADMIN_ANNA.userId);

		expect(accountMock.transferTeamOwnership).toHaveBeenCalledWith(TEAM_A.id, ADMIN_ANNA.userId);
		expect(managedTeams.admins).toEqual([]);
		expect(managedTeams.adminInvite).toBeNull();
		expect(managedTeams.isOwner).toBe(false);
	});
});

describe("leaveAsAdmin", () => {
	const ADMIN_TEAM = { ...TEAM_A, role: "admin" as const };

	it("nimmt das Team aus der Liste, wählt das nächste und verwirft alles Team-Bezogene", async () => {
		accountMock.leaveTeamAsAdmin.mockResolvedValue(undefined);
		managedTeams.teams = [ADMIN_TEAM, TEAM_B];
		managedTeams.selectedTeamId = ADMIN_TEAM.id;
		managedTeams.invite = invite("t1", "ALT");
		managedTeams.admins = [ADMIN_ANNA];

		await managedTeams.leaveAsAdmin();

		expect(accountMock.leaveTeamAsAdmin).toHaveBeenCalledWith("t1");
		expect(managedTeams.teams).toEqual([TEAM_B]);
		expect(managedTeams.selectedTeamId).toBe("t2");
		expect(managedTeams.invite).toBeNull();
		expect(managedTeams.admins).toEqual([]);
	});

	it("lässt die Liste stehen, wenn der Server ablehnt", async () => {
		accountMock.leaveTeamAsAdmin.mockRejectedValue(new Error("offline"));
		managedTeams.teams = [ADMIN_TEAM];
		managedTeams.selectedTeamId = ADMIN_TEAM.id;

		await expect(managedTeams.leaveAsAdmin()).rejects.toThrow("offline");
		expect(managedTeams.teams).toEqual([ADMIN_TEAM]);
	});
});

describe("Teamwechsel", () => {
	it("verwirft Link, Verwalter und Verwalter-Link des bisher ausgewählten Teams", () => {
		managedTeams.selectedTeamId = TEAM_A.id;
		managedTeams.invite = invite(TEAM_A.id, "a");
		managedTeams.adminInvite = invite(TEAM_A.id, "va");
		managedTeams.admins = [ADMIN_ANNA];

		managedTeams.selectedTeamId = TEAM_B.id;

		expect(managedTeams.invite).toBeNull();
		expect(managedTeams.adminInvite).toBeNull();
		expect(managedTeams.admins).toEqual([]);
	});

	it("X → A → B → wieder A, solange A lädt: B beendet die Ladeanzeige nicht und der Link von X bleibt nicht stehen", async () => {
		const TEAM_X = { ...TEAM_A, id: "tx" };
		managedTeams.selectedTeamId = TEAM_X.id;
		managedTeams.invite = invite(TEAM_X.id, "x");
		let resolveA!: (v: unknown) => void;
		let resolveB!: (v: unknown) => void;
		accountMock.getTeamInvite
			.mockImplementationOnce(() => new Promise((r) => (resolveA = r)))
			.mockImplementationOnce(() => new Promise((r) => (resolveB = r)));

		managedTeams.selectedTeamId = TEAM_A.id;
		const a = managedTeams.loadInvite(TEAM_A.id);
		managedTeams.selectedTeamId = TEAM_B.id;
		const b = managedTeams.loadInvite(TEAM_B.id);
		managedTeams.selectedTeamId = TEAM_A.id;
		const aAgain = managedTeams.loadInvite(TEAM_A.id); // teilt den laufenden Abruf
		expect(accountMock.getTeamInvite).toHaveBeenCalledTimes(2);

		resolveB(invite(TEAM_B.id, "b"));
		await b;
		expect(managedTeams.inviteLoading).toBe(true);
		expect(managedTeams.invite).toBeNull();

		resolveA(invite(TEAM_A.id, "a"));
		await Promise.all([a, aAgain]);
		expect(managedTeams.inviteLoading).toBe(false);
		expect(managedTeams.invite?.code).toBe("a");
	});
});

describe("Veraltete Abrufe nach einer Änderung", () => {
	it("ein vor removeAdmin() gestarteter Abruf bringt den entfernten Verwalter und den widerrufenen Link nicht zurück", async () => {
		managedTeams.selectedTeamId = TEAM_A.id;
		let resolveAdmins!: (v: unknown) => void;
		let resolveInvite!: (v: unknown) => void;
		accountMock.listTeamAdmins.mockReturnValue(new Promise((r) => (resolveAdmins = r)));
		accountMock.getAdminInvite.mockReturnValue(new Promise((r) => (resolveInvite = r)));
		accountMock.removeTeamAdmin.mockResolvedValue(undefined);

		const admins = managedTeams.loadAdmins(TEAM_A.id);
		const inv = managedTeams.loadAdminInvite(TEAM_A.id);
		await managedTeams.removeAdmin(ADMIN_ANNA.userId);
		resolveAdmins([ADMIN_ANNA]);
		resolveInvite(invite(TEAM_A.id, "widerrufen"));
		await Promise.all([admins, inv]);

		expect(managedTeams.admins).toEqual([]);
		expect(managedTeams.adminInvite).toBeNull();
	});

	it("dasselbe nach transferOwnership()", async () => {
		managedTeams.teams = [TEAM_A];
		managedTeams.selectedTeamId = TEAM_A.id;
		let resolveAdmins!: (v: unknown) => void;
		let resolveInvite!: (v: unknown) => void;
		accountMock.listTeamAdmins.mockReturnValue(new Promise((r) => (resolveAdmins = r)));
		accountMock.getAdminInvite.mockReturnValue(new Promise((r) => (resolveInvite = r)));
		accountMock.transferTeamOwnership.mockResolvedValue(undefined);
		accountMock.listTeams.mockResolvedValue([{ ...TEAM_A, role: "admin" }]);

		const admins = managedTeams.loadAdmins(TEAM_A.id);
		const inv = managedTeams.loadAdminInvite(TEAM_A.id);
		await managedTeams.transferOwnership(ADMIN_ANNA.userId);
		resolveAdmins([ADMIN_ANNA]);
		resolveInvite(invite(TEAM_A.id, "alt"));
		await Promise.all([admins, inv]);

		expect(managedTeams.admins).toEqual([]);
		expect(managedTeams.adminInvite).toBeNull();
	});
});
