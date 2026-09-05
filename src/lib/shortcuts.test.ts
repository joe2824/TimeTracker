import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Activity } from "./types";
import { defaultSettings } from "./types";
import { resetFakeFs } from "./testing/fakeFs";

vi.mock("@tauri-apps/plugin-fs", async () => (await import("./testing/fakeFs")).fakeFs);
vi.mock("svelte-sonner", () => import("./testing/toastStub"));

/**
 * Ersatz fuer das global-shortcut-Plugin.
 *
 * Ueber `vi.hoisted`, weil vi.mock() an den Anfang der Datei wandert: eine
 * gewoehnliche Konstante waere dort noch nicht angelegt.
 *
 * Der Fake weist ein doppelt vergebenes Kuerzel ab – so verhaelt sich das echte
 * Plugin auch, und genau daran haengt die Frage, ob ein einzelnes untaugliches
 * Kuerzel die uebrigen mitreisst.
 */
const gs = vi.hoisted(() => {
	const registered = new Map<string, (e: { state: string }) => void>();
	return {
		registered,
		register: vi.fn(async (acc: string, cb: (e: { state: string }) => void) => {
			if (registered.has(acc)) throw new Error(`Shortcut ${acc} ist bereits vergeben`);
			registered.set(acc, cb);
		}),
		unregisterAll: vi.fn(async () => {
			registered.clear();
		})
	};
});
vi.mock("@tauri-apps/plugin-global-shortcut", () => ({
	register: gs.register,
	unregisterAll: gs.unregisterAll
}));

const { app } = await import("./app.svelte");
const { acceleratorFromEvent, applyShortcuts } = await import("./shortcuts");

const P1 = "p1";
const P2 = "p2";

function activity(id: string, extra: Partial<Activity> = {}): Activity {
	return { id, name: id, sortOrder: 0, archived: false, isAbsence: false, ...extra };
}

/** Tastendruck nachstellen – `code` ist das, was acceleratorFromEvent auswertet. */
function keyPress(code: string, mods: Partial<KeyboardEvent> = {}): KeyboardEvent {
	return {
		code,
		ctrlKey: false,
		altKey: false,
		shiftKey: false,
		metaKey: false,
		...mods
	} as KeyboardEvent;
}

beforeEach(() => {
	resetFakeFs();
	gs.registered.clear();
	gs.register.mockClear();
	gs.unregisterAll.mockClear();
	app.dispose();
	app.settings = { ...defaultSettings };
	app.activities = [];
	app.running = null;
	app.entriesByMonth = {};
});

describe("acceleratorFromEvent", () => {
	it("baut Modifier und Taste zusammen", () => {
		expect(acceleratorFromEvent(keyPress("KeyT", { ctrlKey: true, shiftKey: true }))).toBe(
			"Control+Shift+T"
		);
	});

	it("nimmt Ziffern, Nummernblock und Funktionstasten", () => {
		expect(acceleratorFromEvent(keyPress("Digit1", { altKey: true }))).toBe("Alt+1");
		expect(acceleratorFromEvent(keyPress("Numpad7", { ctrlKey: true }))).toBe("Control+Numpad7");
		expect(acceleratorFromEvent(keyPress("F9"))).toBe("F9");
	});

	it("liefert null, wenn nur Modifier gedrueckt wurden", () => {
		// Sonst entstuende beim Aufnehmen eines Kuerzels schon ein Eintrag, sobald
		// jemand Strg drueckt – bevor er die eigentliche Taste erreicht hat.
		expect(acceleratorFromEvent(keyPress("ControlLeft", { ctrlKey: true }))).toBeNull();
		expect(acceleratorFromEvent(keyPress("ShiftRight", { shiftKey: true }))).toBeNull();
	});

	it("liefert null fuer Tasten, die Tauri nicht kennt", () => {
		expect(acceleratorFromEvent(keyPress("BracketLeft"))).toBeNull();
	});

	it("nimmt die physische Taste, nicht das erzeugte Zeichen", () => {
		// Auf einer deutschen Tastatur liefert Alt+L ein anderes `key` als auf einer
		// amerikanischen; `code` ist auf beiden KeyL. Ein Kuerzel darf nicht davon
		// abhaengen, welches Layout gerade aktiv ist.
		expect(acceleratorFromEvent(keyPress("KeyL", { altKey: true }))).toBe("Alt+L");
	});
});

describe("applyShortcuts", () => {
	it("registriert Umschalt-Kuerzel und Aktivitaets-Kuerzel", async () => {
		app.settings.toggleShortcut = "Control+Alt+T";
		app.activities = [activity(P1, { shortcut: "Control+Alt+1" })];

		await applyShortcuts();

		expect([...gs.registered.keys()]).toEqual(["Control+Alt+T", "Control+Alt+1"]);
	});

	it("raeumt vor jedem Durchgang auf", async () => {
		app.activities = [activity(P1, { shortcut: "Control+Alt+1" })];
		await applyShortcuts();

		app.activities = [activity(P2, { shortcut: "Control+Alt+2" })];
		await applyShortcuts();

		// Das alte Kuerzel darf nicht liegen bleiben: sonst startete eine geloeschte
		// oder umbelegte Aktivitaet weiter mit.
		expect(gs.unregisterAll).toHaveBeenCalledTimes(2);
		expect([...gs.registered.keys()]).toEqual(["Control+Alt+2"]);
	});

	it("laesst archivierte Aktivitaeten und leere Kuerzel aus", async () => {
		app.activities = [
			activity(P1, { shortcut: "Control+Alt+1", archived: true }),
			activity(P2, { shortcut: "   " }),
			activity("p3")
		];

		await applyShortcuts();

		expect(gs.registered.size).toBe(0);
	});

	it("vergibt ein doppelt hinterlegtes Kuerzel nur einmal", async () => {
		app.activities = [
			activity(P1, { shortcut: "Control+Alt+1" }),
			activity(P2, { shortcut: "Control+Alt+1" })
		];

		await applyShortcuts();

		expect(gs.register).toHaveBeenCalledTimes(1);
		expect(gs.registered.size).toBe(1);
	});

	it("laesst das Umschalt-Kuerzel gewinnen, wenn eine Aktivitaet dasselbe traegt", async () => {
		app.settings.toggleShortcut = "Control+Alt+T";
		app.activities = [activity(P1, { shortcut: "Control+Alt+T" })];

		await applyShortcuts();

		expect(gs.register).toHaveBeenCalledTimes(1);
		// Der Aufruf des Kuerzels muss den Umschalter treffen, nicht den Start.
		const start = vi.spyOn(app, "startActivity").mockResolvedValue();
		const toggle = vi.spyOn(app, "toggleLast").mockResolvedValue();
		gs.registered.get("Control+Alt+T")?.({ state: "Pressed" });
		expect(toggle).toHaveBeenCalled();
		expect(start).not.toHaveBeenCalled();
		start.mockRestore();
		toggle.mockRestore();
	});

	it("reisst die uebrigen Kuerzel nicht mit, wenn eines abgewiesen wird", async () => {
		// Der Fall aus dem Betrieb: ein Kuerzel ist schon von einem anderen Programm
		// belegt, register() wirft. Ohne den Fang blieben alle danach folgenden
		// Aktivitaeten ohne Kuerzel – und zwar lautlos.
		gs.register.mockImplementationOnce(async () => {
			throw new Error("Control+Alt+1 ist bereits vergeben");
		});
		app.activities = [
			activity(P1, { shortcut: "Control+Alt+1" }),
			activity(P2, { shortcut: "Control+Alt+2" })
		];

		await applyShortcuts();

		expect(gs.register).toHaveBeenCalledTimes(2);
		expect([...gs.registered.keys()]).toEqual(["Control+Alt+2"]);
	});

	it("startet die Aktivitaet beim Druck – und nicht beim Loslassen", async () => {
		app.activities = [activity(P1, { shortcut: "Control+Alt+1" })];
		await applyShortcuts();
		const start = vi.spyOn(app, "startActivity").mockResolvedValue();

		gs.registered.get("Control+Alt+1")?.({ state: "Released" });
		expect(start).not.toHaveBeenCalled();

		gs.registered.get("Control+Alt+1")?.({ state: "Pressed" });
		expect(start).toHaveBeenCalledWith(P1);
		start.mockRestore();
	});

	it("registriert gar nichts, wenn nichts hinterlegt ist", async () => {
		app.activities = [activity(P1)];
		await applyShortcuts();
		expect(gs.register).not.toHaveBeenCalled();
		// Aufgeraeumt wird trotzdem – sonst blieben Kuerzel eines frueheren Standes stehen.
		expect(gs.unregisterAll).toHaveBeenCalledTimes(1);
	});
});
