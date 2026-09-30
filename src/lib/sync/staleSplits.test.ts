import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-fs", async () => (await import("../testing/fakeFs")).fakeFs);

const { files, resetFakeFs } = await import("../testing/fakeFs");
const store = await import("../store");
const { rememberStaleSplits, restoreStaleSplits } = await import("./staleSplits");
const { startOfNextDay } = await import("../time/time");
import { anEntry, MONTH, ts } from "../testing/fixtures";

const midnight = startOfNextDay(ts(15, 9));
const ended = anEntry("d1", { startTs: ts(15, 9), endTs: ts(15, 17) });
const continuation = anEntry("d2", { startTs: midnight, endTs: ts(16, 8), autoContinued: true });

beforeEach(() => resetFakeFs());

describe("Rückfragen zu Mitternachts-Teilungen", () => {
	it("übersteht einen Neustart - nur die Ids liegen in der Datei", async () => {
		await store.saveEntries(MONTH, [ended, continuation]);
		await rememberStaleSplits([{ endedEntry: ended, continuationEntry: continuation }]);

		expect(JSON.parse(files.get("data/stale-splits.json")!)).toEqual([
			{ endedId: "d1", continuationId: "d2" }
		]);

		const restored = await restoreStaleSplits();
		expect(restored.map((s) => [s.endedEntry.id, s.continuationEntry.id])).toEqual([["d1", "d2"]]);
	});

	it("liest beide Einträge frisch von der Platte", async () => {
		await store.saveEntries(MONTH, [ended, continuation]);
		await rememberStaleSplits([{ endedEntry: ended, continuationEntry: continuation }]);
		await store.saveEntries(MONTH, [{ ...ended, note: "neu" }, continuation]);

		const [s] = await restoreStaleSplits();
		expect(s.endedEntry.note).toBe("neu");
	});

	it("vergisst die Frage, wenn ein Eintrag fehlt", async () => {
		await store.saveEntries(MONTH, [ended, continuation]);
		await rememberStaleSplits([{ endedEntry: ended, continuationEntry: continuation }]);
		await store.saveEntries(MONTH, [ended]);

		expect(await restoreStaleSplits()).toEqual([]);
		expect(files.has("data/stale-splits.json")).toBe(false);
	});

	it("vergisst die Frage, wenn der Lauf inzwischen bis zur Fortsetzung reicht", async () => {
		await store.saveEntries(MONTH, [ended, continuation]);
		await rememberStaleSplits([{ endedEntry: ended, continuationEntry: continuation }]);
		// Anderswo beantwortet: das Ende steht wieder an Mitternacht.
		await store.saveEntries(MONTH, [{ ...ended, endTs: midnight }, continuation]);

		expect(await restoreStaleSplits()).toEqual([]);
		expect(files.has("data/stale-splits.json")).toBe(false);
	});

	it("legt dieselbe Frage nicht zweimal ab", async () => {
		await store.saveEntries(MONTH, [ended, continuation]);
		const info = { endedEntry: ended, continuationEntry: continuation };
		await rememberStaleSplits([info]);
		await rememberStaleSplits([info]);

		expect(await store.loadStaleSplits()).toHaveLength(1);
	});
});
