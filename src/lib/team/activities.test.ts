// Merge-Regel: Team-Aktivitäten ersetzen nur sich selbst, persönliche bleiben stehen.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Activity } from "../types";
import { resetFakeFs } from "../testing/fakeFs";

vi.mock("@tauri-apps/plugin-fs", async () => (await import("../testing/fakeFs")).fakeFs);
vi.mock("svelte-sonner", () => import("../testing/toastStub"));

const remote = vi.fn();
vi.mock("./api", () => ({ fetchTeamActivities: (...args: unknown[]) => remote(...args) }));

const accountMock = vi.hoisted(() => ({
	linked: false,
	listTeams: vi.fn(),
	listTeamActivities: vi.fn()
}));
vi.mock("../sync/account.svelte", () => ({ account: accountMock }));

const { app } = await import("../app.svelte");
const { loadTeamDevice, saveTeamDevice } = await import("../store");
const { ApiError } = await import("../sync/api");
const { chefTeams } = await import("./chef.svelte");
const { teamJoin } = await import("./state.svelte");
const { syncTeamActivities, syncOwnedTeamActivities, TEAM_ACTIVITY_PREFIX } = await import("./activities");

const PERSONAL: Activity = { id: "p1", name: "Eigene", sortOrder: 0, archived: false, isAbsence: false };

beforeEach(() => {
	resetFakeFs();
	app.dispose();
	app.activities = [PERSONAL];
	remote.mockReset();
	accountMock.linked = false;
	accountMock.listTeams.mockReset();
	accountMock.listTeamActivities.mockReset();
	chefTeams.teams = [];
	chefTeams.selectedTeamId = undefined;
});

describe("syncTeamActivities", () => {
	it("tut nichts ohne Team-Mitgliedschaft", async () => {
		await syncTeamActivities();
		expect(remote).not.toHaveBeenCalled();
		expect(app.activities).toEqual([PERSONAL]);
	});

	it("fügt Team-Aktivitäten mit Namensraum-Id ein, ohne die eigenen anzufassen", async () => {
		await saveTeamDevice({
			teamMemberId: "m1",
			token: "tok",
			teamName: "Vertrieb",
			serverUrl: "https://tt.example.de"
		});
		remote.mockResolvedValue({
			activities: [
				{ id: "a1", name: "Projekt A", isAbsence: false, sortOrder: 0, color: null, archived: false, updatedAt: 1 }
			]
		});

		await syncTeamActivities();

		expect(remote).toHaveBeenCalledWith("https://tt.example.de", "tok");
		expect(app.activities).toHaveLength(2);
		expect(app.activities.find((a) => a.id === PERSONAL.id)).toEqual(PERSONAL);
		const teamActivity = app.activities.find((a) => a.id === `${TEAM_ACTIVITY_PREFIX}a1`);
		expect(teamActivity).toMatchObject({ name: "Projekt A", teamOwned: true });
	});

	it("ein zweiter Abruf ERSETZT die vorigen Team-Aktivitäten in der Auswahl, statt sie zu verdoppeln", async () => {
		await saveTeamDevice({
			teamMemberId: "m1",
			token: "tok",
			teamName: "Vertrieb",
			serverUrl: "https://tt.example.de"
		});
		remote.mockResolvedValue({
			activities: [
				{ id: "a1", name: "Alt", isAbsence: false, sortOrder: 0, color: null, archived: false, updatedAt: 1 }
			]
		});
		await syncTeamActivities();

		remote.mockResolvedValue({
			activities: [
				{ id: "a2", name: "Neu", isAbsence: false, sortOrder: 0, color: null, archived: false, updatedAt: 2 }
			]
		});
		await syncTeamActivities();

		const teamOwned = app.activities.filter((a) => a.teamOwned);
		expect(teamOwned.map((a) => a.name)).toEqual(["Neu"]);
	});

	it("loest eine vom Chef entfernte Aktivität lokal ab, statt sie zu loeschen", async () => {
		// Sonst gingen schon erfasste Stunden lautlos aus dem Bericht verloren -
		// der baut seine Zeilen nur aus der aktuellen activities-Liste (report.ts).
		await saveTeamDevice({
			teamMemberId: "m1",
			token: "tok",
			teamName: "Vertrieb",
			serverUrl: "https://tt.example.de"
		});
		remote.mockResolvedValue({
			activities: [
				{ id: "a1", name: "Alt", isAbsence: false, sortOrder: 0, color: null, archived: false, updatedAt: 1 }
			]
		});
		await syncTeamActivities();
		const oldId = `${TEAM_ACTIVITY_PREFIX}a1`;

		remote.mockResolvedValue({ activities: [] });
		await syncTeamActivities();

		const detached = app.activities.find((a) => a.id === oldId);
		expect(detached).toMatchObject({ name: "Alt", archived: true });
		expect(detached?.teamOwned).toBeUndefined();
	});

	it("bricht still ab, wenn der Server nicht erreichbar ist - persönliche Liste bleibt", async () => {
		await saveTeamDevice({
			teamMemberId: "m1",
			token: "tok",
			teamName: "Vertrieb",
			serverUrl: "https://tt.example.de"
		});
		remote.mockRejectedValue(new Error("Netzwerk weg"));

		await expect(syncTeamActivities()).resolves.toBeUndefined();
		expect(app.activities).toEqual([PERSONAL]);
	});

	it("räumt bei ungültigem Token (401) auf, statt die tote Mitgliedschaft stehen zu lassen", async () => {
		// Ein blosser Netz-Aussetzer (voriger Test) darf nichts anfassen - ein 401
		// heisst dagegen: das Team wurde gelöscht oder dieses Mitglied entfernt.
		await saveTeamDevice({
			teamMemberId: "m1",
			token: "tok",
			teamName: "Vertrieb",
			serverUrl: "https://tt.example.de"
		});
		remote.mockResolvedValue({
			activities: [
				{ id: "a1", name: "Alt", isAbsence: false, sortOrder: 0, color: null, archived: false, updatedAt: 1 }
			]
		});
		await syncTeamActivities();
		const oldId = `${TEAM_ACTIVITY_PREFIX}a1`;
		expect(app.activities.find((a) => a.id === oldId)?.teamOwned).toBe(true);

		remote.mockRejectedValue(new ApiError("Kein Team-Zugang", 401));
		await syncTeamActivities();

		expect(teamJoin.device).toBeNull();
		expect(await loadTeamDevice()).toBeNull();
		// Unveraenderte Id wie beim Entfernen einer einzelnen Aktivität aus einem
		// noch existierenden Team - der Server-Eintrag ist endgültig weg und kann
		// nie wieder mit ihr kollidieren.
		const detached = app.activities.find((a) => a.id === oldId);
		expect(detached).toMatchObject({ name: "Alt", archived: true });
		expect(detached?.teamOwned).toBeUndefined();
	});

	it("laesst beim 401 eigene, per syncOwnedTeamActivities gespiegelte Zeilen unangetastet", async () => {
		// Regression: die Aufräumung galt nur den ÜBER DEN LINK BEIGETRETENEN
		// Zeilen (teamId === undefined). Ein Konto, das gleichzeitig Chef eines
		// anderen Teams ist, darf dessen Zeilen (mit teamId) nicht verlieren, nur
		// weil die eigene, unabhängige Mitgliedschaft anderswo endet.
		accountMock.linked = true;
		accountMock.listTeams.mockResolvedValue([
			{ id: "own1", name: "Eigenes Team", ownerUserId: "u1", createdAt: 1 }
		]);
		accountMock.listTeamActivities.mockResolvedValue([
			{ id: "oa1", name: "Eigene Team-Aktivität", isAbsence: false, sortOrder: 0, color: null, archived: false, updatedAt: 1 }
		]);
		await syncOwnedTeamActivities();
		const ownRow = app.activities.find((a) => a.id === `${TEAM_ACTIVITY_PREFIX}oa1`);
		expect(ownRow).toMatchObject({ teamOwned: true, teamId: "own1" });

		await saveTeamDevice({
			teamMemberId: "m1",
			token: "tok",
			teamName: "Beigetretenes Team",
			serverUrl: "https://tt.example.de"
		});
		remote.mockRejectedValue(new ApiError("Kein Team-Zugang", 401));
		await syncTeamActivities();

		expect(teamJoin.device).toBeNull();
		expect(app.activities.find((a) => a.id === `${TEAM_ACTIVITY_PREFIX}oa1`)).toEqual(ownRow);
	});
});

describe("syncOwnedTeamActivities", () => {
	it("tut nichts ohne Konto", async () => {
		await syncOwnedTeamActivities();
		expect(accountMock.listTeams).not.toHaveBeenCalled();
		expect(app.activities).toEqual([PERSONAL]);
	});

	it("spiegelt die eigene Team-Liste mit Teamnamen und -Id, ohne die eigenen anzufassen", async () => {
		accountMock.linked = true;
		accountMock.listTeams.mockResolvedValue([
			{ id: "t1", name: "Vertrieb", ownerUserId: "u1", createdAt: 1 }
		]);
		accountMock.listTeamActivities.mockResolvedValue([
			{ id: "a1", name: "Projekt A", isAbsence: false, sortOrder: 0, color: null, archived: false, updatedAt: 1 }
		]);

		await syncOwnedTeamActivities();

		expect(app.activities.find((a) => a.id === PERSONAL.id)).toEqual(PERSONAL);
		const teamActivity = app.activities.find((a) => a.id === `${TEAM_ACTIVITY_PREFIX}a1`);
		expect(teamActivity).toMatchObject({
			name: "Projekt A",
			teamOwned: true,
			teamId: "t1",
			teamName: "Vertrieb"
		});
	});

	it("haelt mehrere Teams auseinander - Entfernen in einem Team laesst das andere unberuehrt", async () => {
		// Der haeufigste Fehler hier: ids sind namensraumfrei (nur "team:<id>"),
		// ein Merge ohne Team-Scoping wuerde beim Aufraeumen von Team A auch
		// Zeilen von Team B als "nicht mehr in der Antwort" fehldeuten.
		accountMock.linked = true;
		accountMock.listTeams.mockResolvedValue([
			{ id: "t1", name: "A", ownerUserId: "u1", createdAt: 1 },
			{ id: "t2", name: "B", ownerUserId: "u1", createdAt: 1 }
		]);
		const bActivity = { id: "b1", name: "B-Sache", isAbsence: false, sortOrder: 0, color: null, archived: false, updatedAt: 1 };
		accountMock.listTeamActivities.mockImplementation(async (teamId: string) =>
			teamId === "t1"
				? [{ id: "a1", name: "Alt", isAbsence: false, sortOrder: 0, color: null, archived: false, updatedAt: 1 }]
				: [bActivity]
		);
		await syncOwnedTeamActivities();

		// Team A verliert seine einzige Aktivität, Team B bleibt unveraendert.
		accountMock.listTeamActivities.mockImplementation(async (teamId: string) =>
			teamId === "t1" ? [] : [bActivity]
		);
		await syncOwnedTeamActivities();

		expect(app.activities.find((a) => a.id === `${TEAM_ACTIVITY_PREFIX}b1`)).toMatchObject({
			teamOwned: true,
			teamId: "t2"
		});
		const detachedA = app.activities.find((a) => a.id === `${TEAM_ACTIVITY_PREFIX}a1`);
		expect(detachedA).toMatchObject({ name: "Alt", archived: true });
		expect(detachedA?.teamOwned).toBeUndefined();
	});

	it("loest Zeilen eines komplett gelöschten Teams ab, obwohl es in listTeams() gar nicht mehr auftaucht", async () => {
		// Regression: ein gelöschtes (nicht nur verlassenes) Team fehlt in
		// listTeams() komplett - die Schleife sah bisher nur noch existierende
		// Teams und liess dessen Zeilen für immer als "teamOwned" stehen.
		accountMock.linked = true;
		accountMock.listTeams.mockResolvedValue([
			{ id: "t1", name: "A", ownerUserId: "u1", createdAt: 1 },
			{ id: "t2", name: "B", ownerUserId: "u1", createdAt: 1 }
		]);
		const bActivity = { id: "b1", name: "B-Sache", isAbsence: false, sortOrder: 0, color: null, archived: false, updatedAt: 1 };
		accountMock.listTeamActivities.mockImplementation(async (teamId: string) =>
			teamId === "t1"
				? [{ id: "a1", name: "Alt", isAbsence: false, sortOrder: 0, color: null, archived: false, updatedAt: 1 }]
				: [bActivity]
		);
		await syncOwnedTeamActivities();

		// Team A wird endgültig gelöscht - listTeams() nennt es gar nicht mehr.
		chefTeams.teams = [];
		accountMock.listTeams.mockResolvedValue([{ id: "t2", name: "B", ownerUserId: "u1", createdAt: 1 }]);
		await syncOwnedTeamActivities();

		const detachedA = app.activities.find((a) => a.id === `${TEAM_ACTIVITY_PREFIX}a1`);
		expect(detachedA).toMatchObject({ name: "Alt", archived: true });
		expect(detachedA?.teamOwned).toBeUndefined();
		expect(app.activities.find((a) => a.id === `${TEAM_ACTIVITY_PREFIX}b1`)).toMatchObject({
			teamOwned: true,
			teamId: "t2"
		});
	});

	it("loest Zeilen auch dann ab, wenn das letzte Team gelöscht wird und listTeams() leer zurückkommt", async () => {
		// Der scharfste Fall des vorigen Tests: chefTeams.teams.length === 0 liess
		// die Funktion bisher sofort zurückkehren, bevor sie je aufräumen konnte.
		accountMock.linked = true;
		accountMock.listTeams.mockResolvedValue([{ id: "t1", name: "A", ownerUserId: "u1", createdAt: 1 }]);
		accountMock.listTeamActivities.mockResolvedValue([
			{ id: "a1", name: "Alt", isAbsence: false, sortOrder: 0, color: null, archived: false, updatedAt: 1 }
		]);
		await syncOwnedTeamActivities();

		chefTeams.teams = [];
		accountMock.listTeams.mockResolvedValue([]);
		await syncOwnedTeamActivities();

		const detached = app.activities.find((a) => a.id === `${TEAM_ACTIVITY_PREFIX}a1`);
		expect(detached).toMatchObject({ name: "Alt", archived: true });
		expect(detached?.teamOwned).toBeUndefined();
	});

	it("behält die zuletzt geladenen Team-Aktivitäten, wenn der Server nicht erreichbar ist", async () => {
		accountMock.linked = true;
		accountMock.listTeams.mockResolvedValue([{ id: "t1", name: "A", ownerUserId: "u1", createdAt: 1 }]);
		accountMock.listTeamActivities.mockResolvedValue([
			{ id: "a1", name: "Projekt", isAbsence: false, sortOrder: 0, color: null, archived: false, updatedAt: 1 }
		]);
		await syncOwnedTeamActivities();

		// Neustart ohne Netz: chefTeams beginnt leer, listTeams() schlägt fehl.
		chefTeams.teams = [];
		accountMock.listTeams.mockRejectedValue(new TypeError("Failed to fetch"));
		accountMock.listTeamActivities.mockRejectedValue(new TypeError("Failed to fetch"));
		await syncOwnedTeamActivities();

		expect(app.activities.find((a) => a.id === `${TEAM_ACTIVITY_PREFIX}a1`)).toMatchObject({
			name: "Projekt",
			archived: false,
			teamOwned: true,
			teamId: "t1"
		});
	});
});

describe("Chef ist gleichzeitig Mitglied eines anderen Teams", () => {
	it("syncTeamActivities loest nur die per Link beigetretene Zeile ab, nie die selbst geführte", async () => {
		// Regression: die eigene, gefuehrte Zeile traegt eine teamId - ohne das
		// im Abgleich zu beruecksichtigen, saehe syncTeamActivities sie als "nicht
		// mehr in der Antwort des beigetretenen Teams" an und loeste sie faelschlich.
		accountMock.linked = true;
		accountMock.listTeams.mockResolvedValue([
			{ id: "own1", name: "Eigenes Team", ownerUserId: "u1", createdAt: 1 }
		]);
		accountMock.listTeamActivities.mockResolvedValue([
			{ id: "oa1", name: "Eigene Team-Aktivität", isAbsence: false, sortOrder: 0, color: null, archived: false, updatedAt: 1 }
		]);
		await syncOwnedTeamActivities();
		const ownRow = app.activities.find((a) => a.id === `${TEAM_ACTIVITY_PREFIX}oa1`);
		expect(ownRow).toMatchObject({ teamOwned: true, teamId: "own1" });

		await saveTeamDevice({
			teamMemberId: "m1",
			token: "tok",
			teamName: "Beigetretenes Team",
			serverUrl: "https://tt.example.de"
		});
		remote.mockResolvedValue({ activities: [] }); // das beigetretene Team hat keine Aktivitäten
		await syncTeamActivities();

		expect(app.activities.find((a) => a.id === `${TEAM_ACTIVITY_PREFIX}oa1`)).toEqual(ownRow);
	});
});
