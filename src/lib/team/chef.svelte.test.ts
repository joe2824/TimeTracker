// chefTeams: geteilter Zustand zwischen Team-Tab, Einstellungen und dem
// Aktivitäten-Tab - vor allem die Renn- und Fehlerbehandlung, die hier schon
// einmal stillschweigend verlorenging.
import { beforeEach, describe, expect, it, vi } from "vitest";

const toastError = vi.fn();
vi.mock("svelte-sonner", () => ({
	toast: Object.assign(() => {}, { error: toastError, success: vi.fn(), info: vi.fn(), warning: vi.fn() })
}));

const accountMock = vi.hoisted(() => ({
	linked: true,
	listTeams: vi.fn(),
	createTeam: vi.fn(),
	deleteTeam: vi.fn(),
	getTeamInvite: vi.fn(),
	rotateTeamInvite: vi.fn(),
	listTeamAdmins: vi.fn(),
	removeTeamAdmin: vi.fn(),
	getAdminInvite: vi.fn(),
	rotateAdminInvite: vi.fn(),
	transferTeamOwnership: vi.fn(),
	serverUrl: "https://tt.example.de"
}));
vi.mock("../sync/account.svelte", () => ({ account: accountMock }));

const { chefTeams } = await import("./chef.svelte");

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
	accountMock.getAdminInvite.mockReset();
	accountMock.rotateAdminInvite.mockReset();
	accountMock.transferTeamOwnership.mockReset();
	toastError.mockReset();
	chefTeams.teams = [];
	chefTeams.selectedTeamId = undefined;
	chefTeams.invite = null;
	chefTeams.admins = [];
	chefTeams.adminInvite = null;
});

describe("loadTeams", () => {
	it("teilt einen laufenden Aufruf statt ihn zu verdoppeln", async () => {
		let resolve!: (v: typeof TEAM_A[]) => void;
		accountMock.listTeams.mockReturnValue(new Promise((r) => (resolve = r)));

		const first = chefTeams.loadTeams();
		const second = chefTeams.loadTeams();
		resolve([TEAM_A]);
		await Promise.all([first, second]);

		expect(accountMock.listTeams).toHaveBeenCalledTimes(1);
		expect(chefTeams.teams).toEqual([TEAM_A]);
	});

	it("meldet einen Fehlschlag per Toast, statt die Ablehnung durchzureichen", async () => {
		accountMock.listTeams.mockRejectedValue(new Error("Netzwerk weg"));
		await expect(chefTeams.loadTeams()).resolves.toBe(false);
		expect(toastError).toHaveBeenCalledTimes(1);
	});

	it("eine veraltete Antwort ueberschreibt nicht, was createTeam() inzwischen angelegt hat", async () => {
		let resolve!: (v: typeof TEAM_A[]) => void;
		accountMock.listTeams.mockReturnValue(new Promise((r) => (resolve = r)));
		const stale = chefTeams.loadTeams();

		accountMock.createTeam.mockResolvedValue(TEAM_B);
		await chefTeams.createTeam("B");

		resolve([TEAM_A]); // kommt jetzt erst an, kennt TEAM_B noch nicht

		// false: teams ist jetzt nur lokal fortgeschrieben, kein Serverstand - sonst
		// hielte syncOwnedTeamActivities TEAM_A für gelöscht.
		await expect(stale).resolves.toBe(false);
		expect(chefTeams.teams.some((t) => t.id === TEAM_B.id)).toBe(true);
	});

	it("haengt sich nach deleteTeam() nicht an eine veraltete laufende Anfrage", async () => {
		let resolveStale!: (v: typeof TEAM_A[]) => void;
		accountMock.listTeams.mockReturnValueOnce(new Promise((r) => (resolveStale = r)));
		const stale = chefTeams.loadTeams();

		accountMock.deleteTeam.mockResolvedValue(undefined);
		await chefTeams.deleteTeam(TEAM_B.id);

		accountMock.listTeams.mockResolvedValueOnce([TEAM_A]);
		const fresh = chefTeams.loadTeams();
		resolveStale([TEAM_A, TEAM_B]);

		await expect(fresh).resolves.toBe(true);
		await expect(stale).resolves.toBe(false);
		expect(accountMock.listTeams).toHaveBeenCalledTimes(2);
		expect(chefTeams.teams).toEqual([TEAM_A]);
	});
});

describe("createTeam / deleteTeam", () => {
	it("legt vorn an und waehlt es aus", async () => {
		accountMock.createTeam.mockResolvedValue(TEAM_A);
		const team = await chefTeams.createTeam("A");
		expect(team).toEqual(TEAM_A);
		expect(chefTeams.teams).toEqual([TEAM_A]);
		expect(chefTeams.selectedTeamId).toBe(TEAM_A.id);
	});

	it("entfernt aus der Liste, waehlt bei Bedarf neu und verwirft den alten Link samt Verwaltern", async () => {
		chefTeams.teams = [TEAM_A, TEAM_B];
		chefTeams.selectedTeamId = TEAM_A.id;
		chefTeams.invite = { code: "abc", teamId: TEAM_A.id, createdAt: 1, expiresAt: null, revokedAt: null };
		chefTeams.admins = [ADMIN_ANNA];
		chefTeams.adminInvite = { code: "xyz", teamId: TEAM_A.id, createdAt: 1, expiresAt: null, revokedAt: null };
		accountMock.deleteTeam.mockResolvedValue({ ok: true });

		await chefTeams.deleteTeam(TEAM_A.id);

		expect(chefTeams.teams).toEqual([TEAM_B]);
		expect(chefTeams.selectedTeamId).toBe(TEAM_B.id);
		expect(chefTeams.invite).toBeNull();
		expect(chefTeams.admins).toEqual([]);
		expect(chefTeams.adminInvite).toBeNull();
	});
});

describe("loadInvite", () => {
	it("eine spaeter aufgeloeste, aeltere Anfrage ueberschreibt nicht die neuere fuer dasselbe Team", async () => {
		chefTeams.selectedTeamId = TEAM_A.id;
		let resolveFirst!: (v: unknown) => void;
		accountMock.getTeamInvite
			.mockImplementationOnce(() => new Promise((r) => (resolveFirst = r)))
			.mockImplementationOnce(async () => ({
				code: "neu",
				teamId: TEAM_A.id,
				createdAt: 2,
				expiresAt: null,
				revokedAt: null
			}));

		const first = chefTeams.loadInvite(TEAM_A.id);
		const second = chefTeams.loadInvite(TEAM_A.id);
		await second;
		resolveFirst({ code: "alt", teamId: TEAM_A.id, createdAt: 1, expiresAt: null, revokedAt: null });
		await first;

		expect(chefTeams.invite?.code).toBe("neu");
	});

	it("meldet einen Fehlschlag per Toast und gibt false zurueck, statt einen fehlenden Link vorzutaeuschen", async () => {
		chefTeams.selectedTeamId = TEAM_A.id;
		accountMock.getTeamInvite.mockRejectedValue(new Error("Netzwerk weg"));
		await expect(chefTeams.loadInvite(TEAM_A.id)).resolves.toBe(false);
		expect(toastError).toHaveBeenCalledTimes(1);
	});
});

describe("loadAdmins", () => {
	it("eine spaeter aufgeloeste, aeltere Anfrage ueberschreibt nicht die neuere fuer dasselbe Team", async () => {
		chefTeams.selectedTeamId = TEAM_A.id;
		let resolveFirst!: (v: unknown) => void;
		accountMock.listTeamAdmins
			.mockImplementationOnce(() => new Promise((r) => (resolveFirst = r)))
			.mockImplementationOnce(async () => [ADMIN_ANNA]);

		const first = chefTeams.loadAdmins(TEAM_A.id);
		const second = chefTeams.loadAdmins(TEAM_A.id);
		await second;
		resolveFirst([]);
		await first;

		expect(chefTeams.admins).toEqual([ADMIN_ANNA]);
	});

	it("meldet einen Fehlschlag per Toast", async () => {
		chefTeams.selectedTeamId = TEAM_A.id;
		accountMock.listTeamAdmins.mockRejectedValue(new Error("Netzwerk weg"));
		await expect(chefTeams.loadAdmins(TEAM_A.id)).resolves.toBeUndefined();
		expect(toastError).toHaveBeenCalledTimes(1);
	});
});

describe("removeAdmin", () => {
	it("entfernt aus der Liste und verwirft den (serverseitig widerrufenen) Verwalter-Link", async () => {
		chefTeams.selectedTeamId = TEAM_A.id;
		chefTeams.admins = [ADMIN_ANNA];
		chefTeams.adminInvite = { code: "xyz", teamId: TEAM_A.id, createdAt: 1, expiresAt: null, revokedAt: null };
		accountMock.removeTeamAdmin.mockResolvedValue(undefined);

		await chefTeams.removeAdmin(ADMIN_ANNA.userId);

		expect(chefTeams.admins).toEqual([]);
		expect(chefTeams.adminInvite).toBeNull();
	});

	it("wendet eine veraltete Antwort nicht mehr auf ein inzwischen anderes ausgewaehltes Team an", async () => {
		chefTeams.selectedTeamId = TEAM_A.id;
		chefTeams.admins = [ADMIN_ANNA];
		chefTeams.adminInvite = { code: "xyz", teamId: TEAM_A.id, createdAt: 1, expiresAt: null, revokedAt: null };
		let resolveRemove!: () => void;
		accountMock.removeTeamAdmin.mockReturnValue(new Promise<void>((r) => (resolveRemove = r)));

		const remove = chefTeams.removeAdmin(ADMIN_ANNA.userId);
		chefTeams.selectedTeamId = TEAM_B.id; // Chef wechselt das Team, waehrend der Request noch laeuft
		resolveRemove();
		await remove;

		expect(chefTeams.admins).toEqual([ADMIN_ANNA]);
		expect(chefTeams.adminInvite).not.toBeNull();
	});
});

describe("loadAdminInvite", () => {
	it("eine spaeter aufgeloeste, aeltere Anfrage ueberschreibt nicht die neuere fuer dasselbe Team", async () => {
		chefTeams.selectedTeamId = TEAM_A.id;
		let resolveFirst!: (v: unknown) => void;
		accountMock.getAdminInvite
			.mockImplementationOnce(() => new Promise((r) => (resolveFirst = r)))
			.mockImplementationOnce(async () => ({
				code: "neu",
				teamId: TEAM_A.id,
				createdAt: 2,
				expiresAt: null,
				revokedAt: null
			}));

		const first = chefTeams.loadAdminInvite(TEAM_A.id);
		const second = chefTeams.loadAdminInvite(TEAM_A.id);
		await second;
		resolveFirst({ code: "alt", teamId: TEAM_A.id, createdAt: 1, expiresAt: null, revokedAt: null });
		await first;

		expect(chefTeams.adminInvite?.code).toBe("neu");
	});

	it("meldet einen Fehlschlag per Toast", async () => {
		chefTeams.selectedTeamId = TEAM_A.id;
		accountMock.getAdminInvite.mockRejectedValue(new Error("Netzwerk weg"));
		await expect(chefTeams.loadAdminInvite(TEAM_A.id)).resolves.toBeUndefined();
		expect(toastError).toHaveBeenCalledTimes(1);
	});
});

describe("rotateAdminInvite", () => {
	it("ersetzt den Verwalter-Link des ausgewaehlten Teams", async () => {
		chefTeams.selectedTeamId = TEAM_A.id;
		const inv = { code: "neu", teamId: TEAM_A.id, createdAt: 2, expiresAt: null, revokedAt: null };
		accountMock.rotateAdminInvite.mockResolvedValue(inv);

		await chefTeams.rotateAdminInvite();

		expect(chefTeams.adminInvite).toEqual(inv);
		expect(chefTeams.rotatingAdminInvite).toBe(false);
	});
});

describe("transferOwnership", () => {
	it("verwirft Verwalter und Verwalter-Link und laedt die Teamliste neu (die eigene Rolle kippt)", async () => {
		chefTeams.teams = [TEAM_A];
		chefTeams.selectedTeamId = TEAM_A.id;
		chefTeams.admins = [ADMIN_ANNA];
		chefTeams.adminInvite = { code: "xyz", teamId: TEAM_A.id, createdAt: 1, expiresAt: null, revokedAt: null };
		accountMock.transferTeamOwnership.mockResolvedValue(undefined);
		accountMock.listTeams.mockResolvedValue([{ ...TEAM_A, role: "admin" }]);

		await chefTeams.transferOwnership(ADMIN_ANNA.userId);

		expect(accountMock.transferTeamOwnership).toHaveBeenCalledWith(TEAM_A.id, ADMIN_ANNA.userId);
		expect(chefTeams.admins).toEqual([]);
		expect(chefTeams.adminInvite).toBeNull();
		expect(chefTeams.isOwner).toBe(false);
	});
});
