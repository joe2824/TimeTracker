import { describe, expect, it, vi } from "vitest";
import { tabFocus } from "./tabFocus.svelte";

describe("tabFocus", () => {
	it("wechselt den Haupt-Tab beim Wunsch", () => {
		const navigate = vi.fn();
		tabFocus.onNavigate(navigate);

		tabFocus.request("team");

		expect(navigate).toHaveBeenCalledExactlyOnceWith("team");
	});

	it("setzt bei requestSettings den Unterreiter VOR dem Tabwechsel", () => {
		// Reihenfolge zählt: SettingsPanel liest pendingSettingsTab, sobald es
		// durch den Tabwechsel sichtbar wird - müsste es erst noch warten,
		// bliebe beim ersten Öffnen der falsche Unterreiter stehen.
		let seenDuringNavigate: string | null = null;
		tabFocus.onNavigate(() => {
			seenDuringNavigate = tabFocus.pendingSettingsTab;
		});

		tabFocus.requestSettings("konto");

		expect(seenDuringNavigate).toBe("konto");
		expect(tabFocus.pendingSettingsTab).toBe("konto");
	});

	it("kommt ohne hinterlegten Rueckruf zurecht", () => {
		tabFocus.onNavigate(() => {});
		expect(() => tabFocus.request("team")).not.toThrow();
	});
});
