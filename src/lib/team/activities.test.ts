// Merge-Regel: Team-Aktivitäten ersetzen nur sich selbst, persönliche bleiben stehen.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Activity } from "../types";
import { resetFakeFs } from "../testing/fakeFs";

vi.mock("@tauri-apps/plugin-fs", async () => (await import("../testing/fakeFs")).fakeFs);
vi.mock("svelte-sonner", () => import("../testing/toastStub"));

const remote = vi.fn();
vi.mock("./api", () => ({ fetchTeamActivities: (...args: unknown[]) => remote(...args) }));

const { app } = await import("../app.svelte");
const { saveTeamDevice } = await import("../store");
const { syncTeamActivities, TEAM_ACTIVITY_PREFIX } = await import("./activities");

const PERSONAL: Activity = { id: "p1", name: "Eigene", sortOrder: 0, archived: false, isAbsence: false };

beforeEach(() => {
	resetFakeFs();
	app.dispose();
	app.activities = [PERSONAL];
	remote.mockReset();
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

	it("ein zweiter Abruf ERSETZT die vorigen Team-Aktivitäten, statt sie zu verdoppeln", async () => {
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
		expect(app.activities).toHaveLength(2);
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
});
