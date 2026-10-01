// @vitest-environment happy-dom
// Der Dialog im Ganzen: was er zeigt und was seine Knöpfe auslösen.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, unmount } from "svelte";
import type { Activity } from "$lib/types";
import { defaultSettings } from "$lib/types";
import { files, resetFakeFs } from "$lib/testing/fakeFs";

vi.mock("@tauri-apps/plugin-fs", async () => (await import("$lib/testing/fakeFs")).fakeFs);
vi.mock("svelte-sonner", () => import("$lib/testing/toastStub"));
vi.mock("$lib/sync/account.svelte", () => ({
	account: { addLogoutHook: () => {}, linked: false, firstSyncDone: false, historyIncomplete: false }
}));

const { app } = await import("$lib/app.svelte");
const { default: TeamMergeDialog } = await import("./TeamMergeDialog.svelte");

const row = (id: string, name: string, over: Partial<Activity> = {}): Activity => ({
	id,
	name,
	sortOrder: 0,
	archived: false,
	isAbsence: false,
	...over
});

let dialog: ReturnType<typeof mount> | null = null;

const text = () => document.body.textContent ?? "";
const button = (label: string) =>
	[...document.body.querySelectorAll("button")].find((b) => b.textContent?.trim() === label);
const settle = async () => {
	for (let i = 0; i < 20; i++) {
		await new Promise((r) => setTimeout(r, 5));
		flushSync();
	}
};

beforeEach(() => {
	resetFakeFs();
	files.set("data/settings.json", JSON.stringify(defaultSettings));
	app.dispose();
	app.settings = { ...defaultSettings };
	app.entriesByMonth = {};
	app.activities = [
		row("p1", "Projekt A"),
		row("p2", "Intern"),
		row("team:a1", "Projekt A", { teamOwned: true, teamName: "Vertrieb" }),
		row("team:a2", "Intern", { teamOwned: true, teamName: "Vertrieb" })
	];
});

afterEach(() => {
	if (dialog) unmount(dialog);
	dialog = null;
	document.body.innerHTML = "";
});

describe("TeamMergeDialog", () => {
	it("zeigt die gleichnamigen Aktivitäten zur Auswahl", async () => {
		dialog = mount(TeamMergeDialog, { target: document.body });
		await settle();

		expect(text()).toContain("Gleiche Aktivitäten zusammenführen?");
		expect(text()).toContain("Projekt A");
		expect(text()).toContain("Intern");
		expect(button("Zusammenführen")).toBeDefined();
	});

	it("bleibt zu, wenn nichts gleich heisst", async () => {
		app.activities = [row("p1", "Eigenes"), row("team:a1", "Projekt A", { teamOwned: true })];

		dialog = mount(TeamMergeDialog, { target: document.body });
		await settle();

		expect(text()).not.toContain("Gleiche Aktivitäten zusammenführen?");
	});

	it("führt beim Bestätigen alle gewählten zusammen und schliesst", async () => {
		dialog = mount(TeamMergeDialog, { target: document.body });
		await settle();

		button("Zusammenführen")!.click();
		await settle();

		expect(app.activities.map((a) => a.id)).toEqual(["team:a1", "team:a2"]);
		expect(text()).not.toContain("Gleiche Aktivitäten zusammenführen?");
	});

	it("„Getrennt lassen“ fragt nicht wieder", async () => {
		dialog = mount(TeamMergeDialog, { target: document.body });
		await settle();

		button("Getrennt lassen")!.click();
		await settle();

		expect(app.activities).toHaveLength(4);
		expect(app.settings.teamMergeDeclined).toEqual(["p1>team:a1", "p2>team:a2"]);
		expect(text()).not.toContain("Gleiche Aktivitäten zusammenführen?");
	});
});
