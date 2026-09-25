// Merge-Regel: Team-Aktivitäten ersetzen nur sich selbst, persönliche bleiben stehen.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Activity } from "../types";
import { resetFakeFs } from "../testing/fakeFs";

vi.mock("@tauri-apps/plugin-fs", async () => (await import("../testing/fakeFs")).fakeFs);
vi.mock("svelte-sonner", () => import("../testing/toastStub"));

const remote = vi.fn();
const leaveOnServer = vi.fn();
vi.mock("./api", () => ({
	fetchTeamActivities: (...args: unknown[]) => remote(...args),
	leaveTeamOnServer: (...args: unknown[]) => leaveOnServer(...args)
}));

const accountMock = vi.hoisted(() => ({
	addLogoutHook: () => {},
	linked: false,
	listTeams: vi.fn(),
	listTeamActivities: vi.fn()
}));
vi.mock("../sync/account.svelte", () => ({ account: accountMock }));

const { app } = await import("../app.svelte");
const { loadTeamDevice, loadTeamRemovedFrom, saveTeamDevice } = await import("../store");
const { ApiError } = await import("../sync/api");
const { chefTeams } = await import("./chef.svelte");
const { teamJoin } = await import("./state.svelte");
const { dismissTeamRemoved, leaveTeam, syncTeamActivities, syncOwnedTeamActivities, TEAM_ACTIVITY_PREFIX } = await import("./activities");

const PERSONAL: Activity = { id: "p1", name: "Eigene", sortOrder: 0, archived: false, isAbsence: false };

beforeEach(() => {
	resetFakeFs();
	app.dispose();
	app.activities = [PERSONAL];
	remote.mockReset();
	leaveOnServer.mockReset();
	leaveOnServer.mockResolvedValue({ ok: true });
	teamJoin.removedFrom = null;
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

		// Neue Id: dieselbe Server-Id kann nach einem erneuten Beitritt wiederkommen.
		const detached = app.activities.find((a) => a.name === "Alt");
		expect(detached).toMatchObject({ archived: true });
		expect(detached?.id).not.toBe(oldId);
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

		await expect(syncTeamActivities()).resolves.toBe("offline");
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
		await expect(syncTeamActivities()).resolves.toBe("removed");

		expect(teamJoin.device).toBeNull();
		expect(teamJoin.removedFrom).toBe("Vertrieb");
		// Auch nach einem Neustart noch da - bis jemand ihn wegklickt.
		expect(await loadTeamRemovedFrom()).toBe("Vertrieb");
		await dismissTeamRemoved();
		expect(await loadTeamRemovedFrom()).toBeNull();
		expect(await loadTeamDevice()).toBeNull();
		const detached = app.activities.find((a) => a.name === "Alt");
		expect(detached).toMatchObject({ archived: true });
		expect(detached?.id).not.toBe(oldId);
		expect(detached?.teamOwned).toBeUndefined();
	});

	it("entfernt, neu beigetreten: keine doppelte Aktivität, Stunden hängen an genau einer Zeile", async () => {
		const device = { teamMemberId: "m1", token: "tok", teamName: "Vertrieb", serverUrl: "https://tt.example.de" };
		const a1 = { id: "a1", name: "Projekt A", isAbsence: false, sortOrder: 0, color: null, archived: false, updatedAt: 1 };
		await saveTeamDevice(device);
		remote.mockResolvedValue({ activities: [a1] });
		await syncTeamActivities();

		remote.mockRejectedValue(new ApiError("Kein Team-Zugang", 401));
		await syncTeamActivities();

		await saveTeamDevice({ ...device, teamMemberId: "m2", token: "tok2" });
		remote.mockResolvedValue({ activities: [a1] });
		await syncTeamActivities();

		const ids = app.activities.map((a) => a.id);
		expect(new Set(ids).size).toBe(ids.length);
		expect(app.activities.filter((a) => a.name === "Projekt A")).toHaveLength(2);
		expect(app.activities.filter((a) => a.id === `${TEAM_ACTIVITY_PREFIX}a1`)).toHaveLength(1);
	});

	it("eine 401 zum alten Token löscht keine inzwischen neu geschlossene Mitgliedschaft", async () => {
		const device = { teamMemberId: "m1", token: "alt", teamName: "Vertrieb", serverUrl: "https://tt.example.de" };
		await saveTeamDevice(device);
		let reject!: (e: unknown) => void;
		remote.mockReturnValueOnce(new Promise((_, r) => (reject = r)));
		const pending = syncTeamActivities();

		const fresh = { ...device, teamMemberId: "m2", token: "neu" };
		await saveTeamDevice(fresh);
		reject(new ApiError("Kein Team-Zugang", 401));
		await pending;

		expect(await loadTeamDevice()).toEqual(fresh);
	});

	it("eine ältere Antwort schreibt, wenn der neuere Abgleich offline gescheitert ist", async () => {
		await saveTeamDevice({ teamMemberId: "m1", token: "tok", teamName: "Vertrieb", serverUrl: "https://tt.example.de" });
		let resolveOld!: (v: unknown) => void;
		remote.mockReturnValueOnce(new Promise((r) => (resolveOld = r)));
		const older = syncTeamActivities();
		remote.mockRejectedValueOnce(new Error("Netzwerk weg"));
		await expect(syncTeamActivities()).resolves.toBe("offline");
		resolveOld({
			activities: [{ id: "alt", name: "Alt", isAbsence: false, sortOrder: 0, color: null, archived: false, updatedAt: 1 }]
		});
		await expect(older).resolves.toBe("ok");

		expect(app.activities.find((a) => a.id === `${TEAM_ACTIVITY_PREFIX}alt`)?.teamOwned).toBe(true);
	});

	it("eine ältere Antwort, die nach einer neueren ankommt, schreibt nicht mehr", async () => {
		await saveTeamDevice({ teamMemberId: "m1", token: "tok", teamName: "Vertrieb", serverUrl: "https://tt.example.de" });
		let resolveOld!: (v: unknown) => void;
		remote.mockReturnValueOnce(new Promise((r) => (resolveOld = r)));
		const older = syncTeamActivities();
		remote.mockResolvedValueOnce({
			activities: [{ id: "neu", name: "Neu", isAbsence: false, sortOrder: 0, color: null, archived: false, updatedAt: 2 }]
		});
		await syncTeamActivities();
		resolveOld({ activities: [] });
		await older;

		expect(app.activities.find((a) => a.id === `${TEAM_ACTIVITY_PREFIX}neu`)?.teamOwned).toBe(true);
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
		const detachedA = app.activities.find((a) => a.name === "Alt");
		expect(detachedA).toMatchObject({ archived: true });
		expect(detachedA?.id).not.toBe(`${TEAM_ACTIVITY_PREFIX}a1`);
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

		const detachedA = app.activities.find((a) => a.name === "Alt");
		expect(detachedA).toMatchObject({ archived: true });
		expect(detachedA?.id).not.toBe(`${TEAM_ACTIVITY_PREFIX}a1`);
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

		const detached = app.activities.find((a) => a.name === "Alt");
		expect(detached).toMatchObject({ archived: true });
		expect(detached?.id).not.toBe(`${TEAM_ACTIVITY_PREFIX}a1`);
		expect(detached?.teamOwned).toBeUndefined();
	});

	it("Chef tritt dem eigenen Team per Link bei: keine doppelte Id", async () => {
		const a1 = { id: "a1", name: "Projekt A", isAbsence: false, sortOrder: 0, color: null, archived: false, updatedAt: 1 };
		accountMock.linked = true;
		accountMock.listTeams.mockResolvedValue([{ id: "t1", name: "A", ownerUserId: "u1", createdAt: 1 }]);
		accountMock.listTeamActivities.mockResolvedValue([a1]);
		await syncOwnedTeamActivities();

		await saveTeamDevice({ teamMemberId: "m1", token: "tok", teamName: "A", serverUrl: "https://tt.example.de" });
		remote.mockResolvedValue({ activities: [a1] });
		await syncTeamActivities();
		await syncOwnedTeamActivities();

		const ids = app.activities.map((a) => a.id);
		expect(new Set(ids).size).toBe(ids.length);
		// Die eigene Zeile gewinnt - samt teamId, egal in welcher Reihenfolge abgeglichen wurde.
		expect(app.activities.find((a) => a.id === `${TEAM_ACTIVITY_PREFIX}a1`)?.teamId).toBe("t1");

		await syncTeamActivities();
		expect(app.activities.find((a) => a.id === `${TEAM_ACTIVITY_PREFIX}a1`)?.teamId).toBe("t1");

		// Team als Mitglied verlassen nimmt dem Chef seine eigene Team-Zeile nicht weg.
		await leaveTeam();
		expect(app.activities.find((a) => a.id === `${TEAM_ACTIVITY_PREFIX}a1`)).toMatchObject({
			teamOwned: true,
			teamId: "t1"
		});
		expect(app.activities.filter((a) => a.name === "Projekt A")).toHaveLength(1);
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

describe("leaveTeam", () => {
	it("löst nur die beigetretenen Zeilen, meldet den Austritt und vergisst das Team", async () => {
		const device = { teamMemberId: "m1", token: "tok", teamName: "Süd", serverUrl: "https://tt.example.de" };
		await saveTeamDevice(device);
		app.activities = [
			PERSONAL,
			{ id: "team:j", name: "Beigetreten", sortOrder: 1, archived: false, isAbsence: false, teamOwned: true },
			{ id: "team:o", name: "Eigenes", sortOrder: 2, archived: false, isAbsence: false, teamOwned: true, teamId: "nord" }
		];

		await leaveTeam();

		expect(await loadTeamDevice()).toBeNull();
		expect(teamJoin.device).toBeNull();
		expect(leaveOnServer).toHaveBeenCalledWith(device.serverUrl, device.token);
		expect(app.activities.find((a) => a.name === "Beigetreten")?.teamOwned).toBeUndefined();
		expect(app.activities.find((a) => a.id === "team:o")?.teamOwned).toBe(true);
	});

	it("ist auch offline lokal ausgetreten", async () => {
		await saveTeamDevice({ teamMemberId: "m1", token: "tok", teamName: "Süd", serverUrl: "https://tt.example.de" });
		leaveOnServer.mockRejectedValue(new Error("offline"));

		await leaveTeam();

		expect(await loadTeamDevice()).toBeNull();
	});
});
