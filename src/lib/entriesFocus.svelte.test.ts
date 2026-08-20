import { describe, expect, it, vi } from "vitest";
import { entriesFocus } from "./entriesFocus.svelte";
import { fmtDate } from "./time";

describe("entriesFocus", () => {
	it("wechselt die Ansicht SYNCHRON zum Wunsch", () => {
		// Der Kern: frueher haing der Tabwechsel an einem Effekt auf `pendingDate`.
		// Die Eintraege-Ansicht liest den Wunsch und loescht ihn dabei – lief sie
		// zuerst, sah die Shell nur noch null und blieb, wo sie war. Ein Klick auf
		// einen auffaelligen Tag im Bericht tat dann gar nichts.
		const gezeigt = vi.fn();
		entriesFocus.onShow(gezeigt);

		entriesFocus.requestDate("2026-08-17");

		expect(gezeigt).toHaveBeenCalledTimes(1);
		expect(entriesFocus.pendingDate).toBe("2026-08-17");
	});

	it("laesst sich vom Verbraucher nicht ausbremsen", () => {
		// Genau der Fall, der kaputt war: der Verbraucher raeumt den Wunsch sofort
		// ab. Der Wechsel muss trotzdem passiert sein.
		const gezeigt = vi.fn(() => {
			entriesFocus.pendingDate = null;
		});
		entriesFocus.onShow(gezeigt);

		entriesFocus.requestDate("2026-08-17");

		expect(gezeigt).toHaveBeenCalledTimes(1);
		expect(entriesFocus.pendingDate).toBeNull();
	});

	it("nimmt fuer requestToday den heutigen Tag", () => {
		const gezeigt = vi.fn();
		entriesFocus.onShow(gezeigt);

		entriesFocus.requestToday();

		expect(entriesFocus.pendingDate).toBe(fmtDate(Date.now()));
		expect(gezeigt).toHaveBeenCalledTimes(1);
	});

	it("kommt ohne hinterlegten Rueckruf zurecht", () => {
		// Der Tray hat keine Tabs; ein Wunsch darf dort nicht knallen.
		entriesFocus.onShow(() => {});
		expect(() => entriesFocus.requestDate("2026-01-02")).not.toThrow();
		expect(entriesFocus.pendingDate).toBe("2026-01-02");
	});
});
