import { describe, expect, it, vi } from "vitest";
import { entriesFocus } from "./entriesFocus.svelte";
import { fmtDate } from "../time/time";

describe("entriesFocus", () => {
	it("wechselt die Ansicht SYNCHRON zum Wunsch", () => {
		// Der Tabwechsel muss synchron passieren: hänge er an einem Effekt auf
		// `pendingDate`, könnte die Einträge-Ansicht (die den Wunsch liest und
		// löscht) zuerst laufen, und die Shell sähe nur noch null.
		const displayed = vi.fn();
		entriesFocus.onShow(displayed);

		entriesFocus.requestDate("2026-08-17");

		expect(displayed).toHaveBeenCalledTimes(1);
		expect(entriesFocus.pendingDate).toBe("2026-08-17");
	});

	it("laesst sich vom Verbraucher nicht ausbremsen", () => {
		// Der Verbraucher räumt den Wunsch sofort ab - der Wechsel muss trotzdem
		// passiert sein.
		const displayed = vi.fn(() => {
			entriesFocus.pendingDate = null;
		});
		entriesFocus.onShow(displayed);

		entriesFocus.requestDate("2026-08-17");

		expect(displayed).toHaveBeenCalledTimes(1);
		expect(entriesFocus.pendingDate).toBeNull();
	});

	it("nimmt fuer requestToday den heutigen Tag", () => {
		const displayed = vi.fn();
		entriesFocus.onShow(displayed);

		entriesFocus.requestToday();

		expect(entriesFocus.pendingDate).toBe(fmtDate(Date.now()));
		expect(displayed).toHaveBeenCalledTimes(1);
	});

	it("kommt ohne hinterlegten Rueckruf zurecht", () => {
		// Der Tray hat keine Tabs; ein Wunsch darf dort nicht knallen.
		entriesFocus.onShow(() => {});
		expect(() => entriesFocus.requestDate("2026-01-02")).not.toThrow();
		expect(entriesFocus.pendingDate).toBe("2026-01-02");
	});
});
