// Was aus einem "timetracker://"-Link herausfaellt.
import { describe, expect, it } from "vitest";
import { pairCodeFrom, pairLink } from "./deeplink";

describe("pairCodeAus", () => {
	it("liest den Code", () => {
		expect(pairCodeFrom("timetracker://pair/ABCDEFGHJKLM")).toBe("ABCDEFGHJKLM");
	});

	it("vertraegt einen Schraegstrich am Ende", () => {
		// Je nach Betriebssystem kommt der Link mit oder ohne an.
		expect(pairCodeFrom("timetracker://pair/ABCD/")).toBe("ABCD");
	});

	it("ignoriert Anhaengsel", () => {
		expect(pairCodeFrom("timetracker://pair/ABCD?x=1")).toBe("ABCD");
		expect(pairCodeFrom("timetracker://pair/ABCD#top")).toBe("ABCD");
	});

	it("nimmt Leerzeichen drumherum", () => {
		expect(pairCodeFrom("  timetracker://pair/ABCD  ")).toBe("ABCD");
	});

	it("gibt null bei allem anderen", () => {
		expect(pairCodeFrom("https://example.de/pair/ABCD")).toBeNull();
		expect(pairCodeFrom("timetracker://sonstwas/ABCD")).toBeNull();
		expect(pairCodeFrom("timetracker://pair/")).toBeNull();
		expect(pairCodeFrom("")).toBeNull();
	});

	it("passt zu pairLink", () => {
		expect(pairCodeFrom(pairLink("ABCDEFGHJKLM"))).toBe("ABCDEFGHJKLM");
	});
});
