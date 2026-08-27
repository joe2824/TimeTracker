import { describe, expect, it, vi } from "vitest";
import { entriesFocus } from "./entriesFocus.svelte";
import { fmtDate } from "./time";

describe("entriesFocus", () => {
	it("wechselt die Ansicht SYNCHRON zum Wunsch", () => {
		// Der Tabwechsel muss synchron passieren: haenge er an einem Effekt auf
		// `pendingDate`, koennte die Eintraege-Ansicht (die den Wunsch liest und
		// loescht) zuerst laufen, und die Shell saehe nur noch null.
		const gezeigt = vi.fn();
		entriesFocus.onShow(gezeigt);

		entriesFocus.requestDate("2026-08-17");

		expect(gezeigt).toHaveBeenCalledTimes(1);
		expect(entriesFocus.pendingDate).toBe("2026-08-17");
	});

	it("laesst sich vom Verbraucher nicht ausbremsen", () => {
		// Der Verbraucher raeumt den Wunsch sofort ab - der Wechsel muss trotzdem
		// passiert sein.
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
