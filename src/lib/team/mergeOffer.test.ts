// Nach dem Beitritt: eigene Aktivitäten, die so heissen wie eine des Teams.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Activity } from "../types";
import { defaultSettings } from "../types";
import { files, resetFakeFs } from "../testing/fakeFs";

vi.mock("@tauri-apps/plugin-fs", async () => (await import("../testing/fakeFs")).fakeFs);
vi.mock("svelte-sonner", () => import("../testing/toastStub"));
vi.mock("../sync/account.svelte", () => ({ account: { addLogoutHook: () => {}, linked: false } }));

const { app } = await import("../app.svelte");
const { loadEntries, saveEntries } = await import("../store");
const { findMergeCandidates, resolveMergeOffer } = await import("./mergeOffer");

const own = (id: string, name: string, over: Partial<Activity> = {}): Activity => ({
	id,
	name,
	sortOrder: 0,
	archived: false,
	isAbsence: false,
	...over
});
const team = (id: string, name: string, over: Partial<Activity> = {}): Activity =>
	own(`team:${id}`, name, { teamOwned: true, teamName: "Vertrieb", ...over });

beforeEach(() => {
	resetFakeFs();
	files.set("data/settings.json", JSON.stringify(defaultSettings));
	app.dispose();
	app.settings = { ...defaultSettings };
	app.entriesByMonth = {};
	app.activities = [];
});

describe("findMergeCandidates", () => {
	it("findet eigene Aktivitäten, die wie eine Team-Aktivität heissen", () => {
		const projektA = own("p1", "Projekt A");
		const teamA = team("a1", "Projekt A");

		expect(findMergeCandidates([projektA, own("p2", "Intern"), teamA, team("a2", "Vertrieb")])).toEqual([
			{ own: projektA, team: teamA }
		]);
	});

	it("vergleicht ohne Rücksicht auf Gross-/Kleinschreibung und Leerzeichen am Rand", () => {
		expect(findMergeCandidates([own("p1", "  projekt a "), team("a1", "Projekt A")])).toHaveLength(1);
	});

	it("lässt archivierte, eingebaute und Abwesenheits-Zeilen aus", () => {
		const list = [
			own("p1", "Alt", { archived: true }),
			own("builtin-others", "Others"),
			own("builtin-absence", "Abwesenheiten", { isAbsence: true }),
			team("a1", "Alt"),
			team("a2", "Others"),
			team("a3", "Abwesenheiten", { isAbsence: true }),
			own("p2", "Weg"),
			team("a4", "Weg", { archived: true })
		];

		expect(findMergeCandidates(list)).toEqual([]);
	});

	it("fragt nicht nach den eigenen Team-Listen der Leitung", () => {
		// Dort führt der Aktivitäten-Tab schon von Hand zusammen.
		expect(findMergeCandidates([own("p1", "Projekt A"), team("a1", "Projekt A", { teamId: "t1" })])).toEqual([]);
	});

	it("fragt nach einem abgelehnten Paar nicht erneut", () => {
		const list = [own("p1", "Projekt A"), team("a1", "Projekt A")];

		expect(findMergeCandidates(list, ["p1>team:a1"])).toEqual([]);
	});
});

describe("resolveMergeOffer", () => {
	it("führt die gewählten zusammen und merkt sich die abgelehnten", async () => {
		const projektA = own("p1", "Projekt A");
		const intern = own("p2", "Intern");
		const teamA = team("a1", "Projekt A");
		const teamIntern = team("a2", "Intern");
		app.activities = [projektA, intern, teamA, teamIntern];
		await saveEntries("2026-07", [
			{ id: "e1", activityId: "p1", startTs: Date.UTC(2026, 6, 16, 9), endTs: Date.UTC(2026, 6, 16, 12), note: "", source: "manual" },
			{ id: "e2", activityId: "p2", startTs: Date.UTC(2026, 6, 17, 9), endTs: Date.UTC(2026, 6, 17, 12), note: "", source: "manual" }
		]);

		const merged = await resolveMergeOffer(findMergeCandidates(app.activities), new Set(["p1"]));

		expect(merged).toBe(1);
		expect(app.activities.map((a) => a.id)).toEqual(["p2", "team:a1", "team:a2"]);
		const entries = await loadEntries("2026-07");
		expect(entries.find((e) => e.id === "e1")?.activityId).toBe("team:a1");
		expect(entries.find((e) => e.id === "e2")?.activityId).toBe("p2");
		// Die Ablehnung gilt dauerhaft - sonst käme die Frage bei jedem Start wieder.
		expect(app.settings.teamMergeDeclined).toEqual(["p2>team:a2"]);
		expect(findMergeCandidates(app.activities, app.settings.teamMergeDeclined)).toEqual([]);
	});
});
