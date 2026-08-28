// Was aus einem "timetracker://"-Link herausfaellt.
import { describe, expect, it } from "vitest";
import { pairCodeAus, pairLink } from "./deeplink";

describe("pairCodeAus", () => {
	it("liest den Code", () => {
		expect(pairCodeAus("timetracker://pair/ABCDEFGHJKLM")).toBe("ABCDEFGHJKLM");
	});

	it("vertraegt einen Schraegstrich am Ende", () => {
		// Je nach Betriebssystem kommt der Link mit oder ohne an.
		expect(pairCodeAus("timetracker://pair/ABCD/")).toBe("ABCD");
	});

	it("ignoriert Anhaengsel", () => {
		expect(pairCodeAus("timetracker://pair/ABCD?x=1")).toBe("ABCD");
		expect(pairCodeAus("timetracker://pair/ABCD#top")).toBe("ABCD");
	});

	it("nimmt Leerzeichen drumherum", () => {
		expect(pairCodeAus("  timetracker://pair/ABCD  ")).toBe("ABCD");
	});

	it("gibt null bei allem anderen", () => {
		expect(pairCodeAus("https://example.de/pair/ABCD")).toBeNull();
		expect(pairCodeAus("timetracker://sonstwas/ABCD")).toBeNull();
		expect(pairCodeAus("timetracker://pair/")).toBeNull();
		expect(pairCodeAus("")).toBeNull();
	});

	it("passt zu pairLink", () => {
		expect(pairCodeAus(pairLink("ABCDEFGHJKLM"))).toBe("ABCDEFGHJKLM");
	});
});
