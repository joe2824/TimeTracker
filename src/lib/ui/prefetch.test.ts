import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-fs", async () => (await import("../testing/fakeFs")).fakeFs);

const { warm, invalidate, invalidateAll, onIntent } = await import("./prefetch");

beforeEach(() => {
	invalidateAll();
});

describe("warm", () => {
	it("fragt bei mehrfachem Hovern nur einmal", async () => {
		const fetcher = vi.fn(async () => "wert");
		const [a, b] = await Promise.all([warm("k", fetcher), warm("k", fetcher)]);
		expect(fetcher).toHaveBeenCalledTimes(1);
		expect([a, b]).toEqual(["wert", "wert"]);
	});

	it("gibt das laufende Versprechen heraus, statt ein zweites zu starten", async () => {
		// Der Klick mitten im Laden soll sich anhaengen - sonst kaeme die Antwort
		// zweimal ueber die Leitung.
		let resolveIt: (v: string) => void = () => {};
		const fetcher = vi.fn(() => new Promise<string>((r) => (resolveIt = r)));
		const first = warm("k", fetcher);
		const second = warm("k", fetcher);
		expect(second).toBe(first);
		resolveIt("fertig");
		expect(await second).toBe("fertig");
		expect(fetcher).toHaveBeenCalledTimes(1);
	});

	it("brennt einen Fehlschlag nicht ein", async () => {
		// Sonst wiederholte der naechste Versuch nur den alten Fehler, statt zu fragen.
		const failing = vi.fn(async () => {
			throw new Error("kein Netz");
		});
		await expect(warm("k", failing)).rejects.toThrow("kein Netz");

		const working = vi.fn(async () => "da");
		expect(await warm("k", working)).toBe("da");
		expect(working).toHaveBeenCalledTimes(1);
	});

	it("fragt nach Ablauf der Frist erneut", async () => {
		const fetcher = vi.fn(async () => "wert");
		await warm("k", fetcher, 0);
		await warm("k", fetcher, 0);
		expect(fetcher).toHaveBeenCalledTimes(2);
	});

	it("invalidate zwingt zur naechsten Anfrage", async () => {
		const fetcher = vi.fn(async () => "wert");
		await warm("k", fetcher);
		invalidate("k");
		await warm("k", fetcher);
		expect(fetcher).toHaveBeenCalledTimes(2);
	});

	it("haelt Schluessel auseinander", async () => {
		const fetcher = vi.fn(async () => "wert");
		await Promise.all([warm("a", fetcher), warm("b", fetcher)]);
		expect(fetcher).toHaveBeenCalledTimes(2);
	});
});

describe("onIntent", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	it("laedt erst nach der Entprellung", () => {
		const run = vi.fn();
		const h = onIntent(run, 100);
		h.onpointerenter();
		expect(run).not.toHaveBeenCalled();
		vi.advanceTimersByTime(100);
		expect(run).toHaveBeenCalledTimes(1);
		vi.useRealTimers();
	});

	it("laedt nicht, wenn der Zeiger vorher weiterzieht", () => {
		// Eine Maus, die ueber die Tab-Leiste wischt, darf nicht jedes Ziel ausloesen.
		const run = vi.fn();
		const h = onIntent(run, 100);
		h.onpointerenter();
		vi.advanceTimersByTime(50);
		h.onpointerleave();
		vi.advanceTimersByTime(200);
		expect(run).not.toHaveBeenCalled();
		vi.useRealTimers();
	});

	it("beim Weiterwischen bleibt nur das letzte Ziel uebrig", () => {
		const earlier = vi.fn();
		const later = vi.fn();
		onIntent(earlier, 100).onpointerenter();
		vi.advanceTimersByTime(50);
		onIntent(later, 100).onpointerenter();
		vi.advanceTimersByTime(100);
		expect(earlier).not.toHaveBeenCalled();
		expect(later).toHaveBeenCalledTimes(1);
		vi.useRealTimers();
	});

	it("Tastaturfokus und Beruehrung zaehlen genauso", () => {
		const run = vi.fn();
		const h = onIntent(run, 100);
		h.onfocus();
		vi.advanceTimersByTime(100);
		h.ontouchstart();
		vi.advanceTimersByTime(100);
		expect(run).toHaveBeenCalledTimes(2);
		vi.useRealTimers();
	});
});
