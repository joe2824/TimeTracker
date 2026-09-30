import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-fs", async () => (await import("./testing/fakeFs")).fakeFs);

const { mergeOntoDisk } = await import("./store");
import { anEntry } from "./testing/fixtures";

describe("mergeOntoDisk - nur schliessen, solange noch offen", () => {
	const open = anEntry("t", { startTs: 1000, endTs: null });
	const closedBySync = { ...open, endTs: 5000 };
	const closeIfOpen = new Set(["t"]);

	it("schliesst, wenn der Eintrag auf der Platte noch offen ist", () => {
		expect(mergeOntoDisk([open], [closedBySync], [open], true, closeIfOpen)).toEqual([closedBySync]);
	});

	it("behält einen inzwischen gestoppten Timer", () => {
		const stopped = { ...open, endTs: 3000 };
		expect(mergeOntoDisk([open], [closedBySync], [stopped], true, closeIfOpen)).toEqual([stopped]);
	});

	it("legt einen inzwischen gelöschten Eintrag nicht wieder an", () => {
		expect(mergeOntoDisk([open], [closedBySync], [], true, closeIfOpen)).toEqual([]);
	});

	it("ohne die Angabe gilt weiter die eigene Änderung", () => {
		const stopped = { ...open, endTs: 3000 };
		expect(mergeOntoDisk([open], [closedBySync], [stopped])).toEqual([closedBySync]);
	});
});
