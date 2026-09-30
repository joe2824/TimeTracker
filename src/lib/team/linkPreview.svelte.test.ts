import { describe, expect, it, vi } from "vitest";
import { LinkPreview } from "./linkPreview.svelte";

describe("LinkPreview", () => {
	it("lädt die Vorschau und fängt einen Fehlschlag als 'error' ab", async () => {
		const fetchPreview = vi.fn().mockResolvedValueOnce({ teamName: "Vertrieb" });
		const preview = new LinkPreview(fetchPreview);

		await preview.load("https://tt.example.de", "code1").done;
		expect(preview.state).toEqual({ teamName: "Vertrieb" });
		expect(fetchPreview).toHaveBeenCalledWith("https://tt.example.de", "code1");

		fetchPreview.mockRejectedValueOnce(new Error("abgelaufen"));
		await preview.load("https://tt.example.de", "code2").done;
		expect(preview.state).toBe("error");
	});

	it("zeigt 'loading', solange die Anfrage läuft", () => {
		const preview = new LinkPreview(() => new Promise(() => {}));
		preview.state = "error";
		preview.load("https://tt.example.de", "code1");
		expect(preview.state).toBe("loading");
	});

	it("ignoriert die späte Antwort eines älteren Links", async () => {
		let resolveFirst!: (v: { teamName: string }) => void;
		const fetchPreview = vi
			.fn()
			.mockImplementationOnce(() => new Promise((resolve) => (resolveFirst = resolve)))
			.mockResolvedValueOnce({ teamName: "Einkauf" });
		const preview = new LinkPreview(fetchPreview);

		const first = preview.load("https://tt.example.de", "codeA");
		const second = preview.load("https://tt.example.de", "codeB");
		await second.done;
		resolveFirst({ teamName: "Vertrieb" });
		await first.done;

		expect(preview.state).toEqual({ teamName: "Einkauf" });
		expect(preview.isCurrent(first.run)).toBe(false);
		expect(preview.isCurrent(second.run)).toBe(true);
	});

	it("ignoriert den Fehlschlag eines älteren Links", async () => {
		let rejectFirst!: (e: Error) => void;
		const fetchPreview = vi
			.fn()
			.mockImplementationOnce(() => new Promise((_, reject) => (rejectFirst = reject)))
			.mockResolvedValueOnce({ teamName: "Einkauf" });
		const preview = new LinkPreview(fetchPreview);

		const first = preview.load("https://tt.example.de", "codeA");
		await preview.load("https://tt.example.de", "codeB").done;
		rejectFirst(new Error("abgelaufen"));
		await first.done;

		expect(preview.state).toEqual({ teamName: "Einkauf" });
	});
});
