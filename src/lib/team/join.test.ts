// Beitritt legt das Team-Token ab UND lädt sofort die gemeinsamen Aktivitäten -
// sonst sähe ein schon laufendes Gerät sie erst nach dem nächsten Start.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetFakeFs } from "../testing/fakeFs";

vi.mock("@tauri-apps/plugin-fs", async () => (await import("../testing/fakeFs")).fakeFs);
vi.mock("svelte-sonner", () => import("../testing/toastStub"));

const joinTeam = vi.fn();
const fetchTeamActivities = vi.fn();
vi.mock("./api", () => ({
	joinTeam: (...args: unknown[]) => joinTeam(...args),
	fetchTeamActivities: (...args: unknown[]) => fetchTeamActivities(...args)
}));

const { app } = await import("../app.svelte");
const { saveActivities } = await import("../store");
const { completeTeamJoin } = await import("./join");
const { TEAM_ACTIVITY_PREFIX } = await import("./activities");

beforeEach(() => {
	resetFakeFs();
	app.dispose();
	app.activities = [];
	joinTeam.mockReset();
	fetchTeamActivities.mockReset();
});

describe("completeTeamJoin", () => {
	it("laedt die gemeinsamen Aktivitäten direkt nach dem Beitritt nach", async () => {
		joinTeam.mockResolvedValue({ teamMemberId: "m1", token: "tok", teamName: "Vertrieb" });
		fetchTeamActivities.mockResolvedValue({
			activities: [
				{ id: "a1", name: "Projekt A", isAbsence: false, sortOrder: 0, color: null, archived: false, updatedAt: 1 }
			]
		});

		await completeTeamJoin("https://tt.example.de", "code123", "Anna Meier");

		expect(fetchTeamActivities).toHaveBeenCalledWith("https://tt.example.de", "tok");
		expect(app.activities.find((a) => a.id === `${TEAM_ACTIVITY_PREFIX}a1`)).toMatchObject({
			name: "Projekt A",
			teamOwned: true
		});
	});

	it("laesst den Beitritt gelingen, auch wenn das Nachladen der Aktivitäten scheitert", async () => {
		joinTeam.mockResolvedValue({ teamMemberId: "m1", token: "tok", teamName: "Vertrieb" });
		fetchTeamActivities.mockRejectedValue(new Error("Netzwerk weg"));

		await expect(completeTeamJoin("https://tt.example.de", "code123", "Anna Meier")).resolves.toMatchObject({
			teamName: "Vertrieb"
		});
	});

	it("behält die persönlichen Aktivitäten, wenn die App noch nicht geladen ist (Web-Route)", async () => {
		await saveActivities([{ id: "mine", name: "Eigenes Projekt", isAbsence: false, archived: false, sortOrder: 0 }]);
		app.activities = [];
		app.loaded = false;
		joinTeam.mockResolvedValue({ teamMemberId: "m1", token: "tok", teamName: "Vertrieb" });
		fetchTeamActivities.mockResolvedValue({
			activities: [
				{ id: "a1", name: "Projekt A", isAbsence: false, sortOrder: 0, color: null, archived: false, updatedAt: 1 }
			]
		});

		await completeTeamJoin("https://tt.example.de", "code123", "Anna Meier");

		expect(app.activities.map((a) => a.id)).toContain("mine");
		expect(app.activities.map((a) => a.id)).toContain(`${TEAM_ACTIVITY_PREFIX}a1`);
		app.dispose();
	});
});
