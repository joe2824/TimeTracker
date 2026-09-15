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
	serverUrl: "https://tt.example.de"
}));
vi.mock("../sync/account.svelte", () => ({ account: accountMock }));

const { chefTeams } = await import("./chef.svelte");

const TEAM_A = { id: "t1", name: "A", ownerUserId: "u1", createdAt: 1 };
const TEAM_B = { id: "t2", name: "B", ownerUserId: "u1", createdAt: 1 };

beforeEach(() => {
	accountMock.linked = true;
	accountMock.listTeams.mockReset();
	accountMock.createTeam.mockReset();
	accountMock.deleteTeam.mockReset();
	accountMock.getTeamInvite.mockReset();
	accountMock.rotateTeamInvite.mockReset();
	toastError.mockReset();
	chefTeams.teams = [];
	chefTeams.selectedTeamId = undefined;
	chefTeams.invite = null;
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
		await expect(chefTeams.loadTeams()).resolves.toBeUndefined();
		expect(toastError).toHaveBeenCalledTimes(1);
	});

	it("eine veraltete Antwort ueberschreibt nicht, was createTeam() inzwischen angelegt hat", async () => {
		let resolve!: (v: typeof TEAM_A[]) => void;
		accountMock.listTeams.mockReturnValue(new Promise((r) => (resolve = r)));
		const stale = chefTeams.loadTeams();

		accountMock.createTeam.mockResolvedValue(TEAM_B);
		await chefTeams.createTeam("B");

		resolve([TEAM_A]); // kommt jetzt erst an, kennt TEAM_B noch nicht
		await stale;

		expect(chefTeams.teams.some((t) => t.id === TEAM_B.id)).toBe(true);
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

	it("entfernt aus der Liste, waehlt bei Bedarf neu und verwirft den alten Link", async () => {
		chefTeams.teams = [TEAM_A, TEAM_B];
		chefTeams.selectedTeamId = TEAM_A.id;
		chefTeams.invite = { code: "abc", teamId: TEAM_A.id, createdAt: 1, expiresAt: null, revokedAt: null };
		accountMock.deleteTeam.mockResolvedValue({ ok: true });

		await chefTeams.deleteTeam(TEAM_A.id);

		expect(chefTeams.teams).toEqual([TEAM_B]);
		expect(chefTeams.selectedTeamId).toBe(TEAM_B.id);
		expect(chefTeams.invite).toBeNull();
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

	it("meldet einen Fehlschlag per Toast", async () => {
		chefTeams.selectedTeamId = TEAM_A.id;
		accountMock.getTeamInvite.mockRejectedValue(new Error("Netzwerk weg"));
		await expect(chefTeams.loadInvite(TEAM_A.id)).resolves.toBeUndefined();
		expect(toastError).toHaveBeenCalledTimes(1);
	});
});
