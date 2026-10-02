// @vitest-environment happy-dom
// Der Dialog „Neuer Eintrag“: womit er Von/Bis vorbelegt und wann sie nachziehen.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, unmount } from "svelte";
import { defaultSettings } from "$lib/types";
import { files, resetFakeFs } from "$lib/testing/fakeFs";
import { anActivity, anEntry } from "$lib/testing/fixtures";
import { wallToTs } from "$lib/time/tz";

vi.mock("@tauri-apps/plugin-fs", async () => (await import("$lib/testing/fakeFs")).fakeFs);
vi.mock("svelte-sonner", () => import("$lib/testing/toastStub"));
vi.mock("$lib/sync/account.svelte", () => ({
	account: {
		addLogoutHook: () => {},
		linked: false,
		firstSyncDone: false,
		historyIncomplete: false,
		fetchingMonths: []
	}
}));

const { app } = await import("$lib/app.svelte");
const { default: EntryEditor } = await import("./EntryEditor.svelte");

const MONTH = "2026-06";
const at = (day: number, hour: number, minute = 0, second = 0) =>
	wallToTs(2026, 6, day, hour, minute, second);
/** „Jetzt“ im Test: der 10. Juni, 15:20 – die volle Stunde dazu ist 15:00. */
const NOW = at(10, 15, 20);

let editor: ReturnType<typeof mount> | null = null;

const settle = async () => {
	for (let i = 0; i < 20; i++) {
		await new Promise((r) => setTimeout(r, 5));
		flushSync();
	}
};

const field = (id: string) => document.getElementById(id) as HTMLInputElement;
const times = () => [field("start").value, field("end").value];

async function type(id: string, value: string, event: "input" | "change" = "input") {
	const input = field(id);
	input.value = value;
	input.dispatchEvent(new Event("input", { bubbles: true }));
	if (event === "change") input.dispatchEvent(new Event("change", { bubbles: true }));
	await settle();
}

/** Den Dialog über den Knopf „Eintrag“ öffnen – der nimmt immer heute. */
async function openForToday() {
	[...document.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Eintrag")!.click();
	await settle();
}

/** Den Dialog über das Plus in der Zeile eines Tages öffnen. */
async function openForDay(date: string) {
	document
		.querySelector<HTMLButtonElement>(`#day-row-${date} button[title="Eintrag für diesen Tag"]`)!
		.click();
	await settle();
}

async function render() {
	editor = mount(EntryEditor, { target: document.body });
	await settle();
}

beforeEach(() => {
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(NOW);
	resetFakeFs();
	files.set("data/settings.json", JSON.stringify(defaultSettings));
	app.dispose();
	app.now = NOW;
	app.settings = { ...defaultSettings };
	app.activities = [anActivity("proj", { name: "Projekt A" })];
	app.entriesByMonth = {
		[MONTH]: [
			anEntry("today", { activityId: "proj", startTs: at(10, 9), endTs: at(10, 10, 30) }),
			anEntry("before", { activityId: "proj", startTs: at(9, 8), endTs: at(9, 9, 15) })
		]
	};
});

afterEach(() => {
	if (editor) unmount(editor);
	editor = null;
	document.body.innerHTML = "";
	vi.useRealTimers();
});

describe("Neuer Eintrag: Vorbelegung von Von und Bis", () => {
	it("schliesst über den Knopf „Eintrag“ an den letzten Eintrag von heute an", async () => {
		await render();
		await openForToday();
		expect(times()).toEqual(["10:30", "10:30"]);
	});

	it("schliesst über das Plus einer Tageszeile an den letzten Eintrag dieses Tages an", async () => {
		await render();
		await openForDay("2026-06-09");
		expect(times()).toEqual(["09:15", "09:15"]);
	});

	it("nimmt an einem Tag ohne Einträge die aktuelle volle Stunde", async () => {
		await render();
		await openForDay("2026-06-08");
		expect(times()).toEqual(["15:00", "15:00"]);
	});

	it("zieht beim Datumswechsel nach, solange die Zeiten unberührt sind", async () => {
		await render();
		await openForToday();

		await type("date", "2026-06-09");
		expect(times()).toEqual(["09:15", "09:15"]);

		await type("date", "2026-06-08");
		expect(times()).toEqual(["15:00", "15:00"]);

		await type("date", "2026-06-10");
		expect(times()).toEqual(["10:30", "10:30"]);
	});

	it("zieht auch nach, wenn das Datum mit den Pfeiltasten wechselt", async () => {
		// Die Pfeiltasten lösen im Datumsfeld kein Eingabe-Ereignis aus.
		await render();
		await openForToday();

		field("date").dispatchEvent(
			new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true })
		);
		await settle();

		expect(field("date").value).toBe("2026-06-09");
		expect(times()).toEqual(["09:15", "09:15"]);
	});

	it("lässt beim Datumswechsel stehen, was jemand selbst eingetragen hat", async () => {
		await render();
		await openForToday();
		await type("end", "12:00", "change");

		await type("date", "2026-06-09");
		expect(times()).toEqual(["10:30", "12:00"]);
	});

	it("speichert im Anschluss an einen Eintrag, der mitten in der Minute endet", async () => {
		app.entriesByMonth = {
			[MONTH]: [anEntry("timer", { activityId: "proj", startTs: at(10, 13), endTs: at(10, 14, 0, 22) })]
		};
		await render();
		await openForToday();
		expect(times()).toEqual(["14:00", "14:00"]);

		await type("act", "Projekt A");
		await type("end", "15:00", "change");
		field("start").closest("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
		await settle();

		const created = app.monthEntries(MONTH).find((e) => e.id !== "timer");
		expect(created).toMatchObject({ startTs: at(10, 14, 0, 22), endTs: at(10, 15) });
	});
});

describe("Eintrag bearbeiten", () => {
	it("behält seine Zeiten, wenn das Datum wechselt", async () => {
		await render();
		[...document.querySelectorAll("button")].find((b) => b.textContent?.includes("09:00–10:30"))!.click();
		await settle();
		expect(times()).toEqual(["09:00", "10:30"]);

		await type("date", "2026-06-09");
		expect(times()).toEqual(["09:00", "10:30"]);
	});
});
