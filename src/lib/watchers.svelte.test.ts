import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Activity, Entry } from "./types";
import { defaultSettings } from "./types";
import { resetFakeFs } from "./testing/fakeFs";
import { monthKey } from "./time";

vi.mock("@tauri-apps/plugin-fs", async () => (await import("./testing/fakeFs")).fakeFs);
vi.mock("svelte-sonner", () => ({
	toast: Object.assign(vi.fn(), { info() {}, error() {}, success() {}, warning() {} })
}));

/**
 * IPC-Ersatz. `idle_seconds` liefert, was der jeweilige Test vorgibt – ohne das
 * haengt die Leerlauf-Erkennung an der echten Tastatur der Maschine, auf der die
 * Suite gerade laeuft.
 */
const ipc = vi.hoisted(() => ({
	idleSeconds: 0,
	invoke: vi.fn()
}));
ipc.invoke.mockImplementation(async (cmd: string) => (cmd === "idle_seconds" ? ipc.idleSeconds : undefined));
vi.mock("@tauri-apps/api/core", () => ({ invoke: ipc.invoke }));

const meldungen = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("@tauri-apps/plugin-notification", () => ({ sendNotification: meldungen.send }));
// Die Berechtigung ist hier nicht der Gegenstand: immer erteilt.
vi.mock("./reminders", () => ({ ensureNotificationPermission: async () => true }));

const { app } = await import("./app.svelte");
const { resolveIdle, resolveLongTimer, startWatchers, stopWatchers, watchers } = await import(
	"./watchers.svelte"
);

const P1 = "p1";
const P2 = "p2";
const AKTIVITAETEN: Activity[] = [
	{ id: P1, name: "Projekt 1", sortOrder: 0, archived: false, isAbsence: false },
	{ id: P2, name: "Projekt 2", sortOrder: 1, archived: false, isAbsence: false }
];

/** Ein Tag ohne Tagesmeldung: 10 Uhr steht nicht in PING_HOURS (9/12/15/17). */
const STILLE_STUNDE = new Date(2026, 7, 24, 10, 0, 0);

function laufend(startTs: number, activityId = P1): Entry {
	return { id: `r-${startTs}-${activityId}`, activityId, startTs, endTs: null, note: "", source: "timer" };
}

/** Einen laufenden Timer einhaengen, der vor `sekunden` begonnen hat. */
function timerLaeuftSeit(sekunden: number, activityId = P1): Entry {
	const start = Date.now() - sekunden * 1000;
	const e = laufend(start, activityId);
	app.entriesByMonth[monthKey(start)] = [e];
	app.running = e;
	app.now = Date.now();
	return e;
}

/** Einen Sekundentakt des Waechters durchlaufen lassen. */
async function tick(n = 1) {
	await vi.advanceTimersByTimeAsync(1000 * n);
}

beforeEach(async () => {
	resetFakeFs();
	vi.useFakeTimers();
	vi.setSystemTime(STILLE_STUNDE);
	app.dispose();
	app.settings = { ...defaultSettings };
	app.activities = [...AKTIVITAETEN];
	app.running = null;
	app.entriesByMonth = {};
	app.now = Date.now();
	watchers.idlePrompt = null;
	watchers.longTimerPrompt = null;
	ipc.idleSeconds = 0;
	ipc.invoke.mockClear();
	meldungen.send.mockClear();

	// Einen Takt ohne laufenden Timer: der setzt die modulinternen Merker zurueck,
	// die sonst aus dem vorigen Test stehen blieben (sie leben am Modul, nicht am
	// Zustand). Erst danach beginnt der eigentliche Fall.
	startWatchers();
	await tick();
	ipc.invoke.mockClear();
	meldungen.send.mockClear();
});

afterEach(() => {
	stopWatchers();
	vi.useRealTimers();
});

describe("Tray-Tooltip", () => {
	it("meldet Aktivitaet und laufende Zeit", async () => {
		timerLaeuftSeit(3661); // 1:01:01
		await tick();

		expect(ipc.invoke).toHaveBeenCalledWith("set_tray_tooltip", {
			text: "Projekt 1 – 1:01:01"
		});
	});

	it("schickt bei unveraenderter Anzeige nichts ueber die Bruecke", async () => {
		timerLaeuftSeit(10);
		await tick();
		ipc.invoke.mockClear();

		// Zweiter Takt, ohne dass app.now weiterlaeuft: gleiche Anzeige.
		await tick();

		const tooltips = ipc.invoke.mock.calls.filter(([cmd]) => cmd === "set_tray_tooltip");
		expect(tooltips).toHaveLength(0);
	});

	it("faellt beim Stoppen auf den blanken Namen zurueck", async () => {
		timerLaeuftSeit(10);
		await tick();
		app.running = null;
		await tick();

		expect(ipc.invoke).toHaveBeenLastCalledWith("set_tray_tooltip", { text: "TimeTracker" });
	});
});

describe("Auto-Stop-Warnung", () => {
	it("meldet einen Timer, der laenger als die Grenze laeuft", async () => {
		app.settings.maxTimerHours = 10;
		timerLaeuftSeit(10 * 3600 + 5);
		await tick();

		expect(watchers.longTimerPrompt).toMatchObject({ activityId: P1 });
		expect(meldungen.send).toHaveBeenCalledTimes(1);
	});

	it("meldet denselben Lauf kein zweites Mal", async () => {
		app.settings.maxTimerHours = 10;
		timerLaeuftSeit(10 * 3600 + 5);
		await tick();
		// Der Benutzer klickt die Rueckfrage weg, der Timer laeuft weiter.
		watchers.longTimerPrompt = null;
		meldungen.send.mockClear();

		await tick(5);

		expect(watchers.longTimerPrompt).toBeNull();
		expect(meldungen.send).not.toHaveBeenCalled();
	});

	it("stellt die Warnung bei einem Aktivitaetswechsel wieder scharf", async () => {
		app.settings.maxTimerHours = 10;
		timerLaeuftSeit(10 * 3600 + 5);
		await tick();
		watchers.longTimerPrompt = null;
		meldungen.send.mockClear();

		// Anderer Lauf, ebenfalls ueber der Grenze.
		timerLaeuftSeit(10 * 3600 + 5, P2);
		await tick();

		expect(watchers.longTimerPrompt).toMatchObject({ activityId: P2 });
		expect(meldungen.send).toHaveBeenCalledTimes(1);
	});

	it("ist mit maxTimerHours = 0 abgeschaltet", async () => {
		app.settings.maxTimerHours = 0;
		timerLaeuftSeit(50 * 3600);
		await tick();

		expect(watchers.longTimerPrompt).toBeNull();
		expect(meldungen.send).not.toHaveBeenCalled();
	});

	it("zaehlt den ganzen Lauf, nicht nur das Stueck seit Mitternacht", async () => {
		// Ein ueber Mitternacht geteilter Lauf: zwei Eintraege, die aneinander
		// stossen. Zaehlte die Warnung nur das letzte Stueck, meldete sie sich bei
		// einem vergessenen Timer jeden Tag aufs Neue.
		// Die Grenze liegt bewusst ZWISCHEN beiden Zeitspannen: das laufende Stueck
		// ist 10 Stunden alt, der ganze Lauf 18. Nur so faellt auf, wenn hier
		// wieder das letzte Stueck gezaehlt wird – bei einer Grenze unter 10 Stunden
		// schluege beides an und der Test bewiese nichts.
		app.settings.maxTimerHours = 12;
		const mitternacht = new Date(2026, 7, 24, 0, 0, 0).getTime();
		const gestern = laufend(mitternacht - 8 * 3600 * 1000);
		gestern.endTs = mitternacht;
		const heute = laufend(mitternacht);
		app.entriesByMonth[monthKey(mitternacht)] = [gestern, heute];
		app.running = heute;
		app.now = Date.now(); // 10 Uhr, siehe STILLE_STUNDE

		await tick();

		expect(watchers.longTimerPrompt?.startTs).toBe(gestern.startTs);
	});
});

describe("Leerlauf-Erkennung", () => {
	it("fragt nach, sobald die Schwelle ueberschritten ist", async () => {
		app.settings.idleThresholdMin = 10;
		timerLaeuftSeit(3600);
		ipc.idleSeconds = 11 * 60;
		await tick();

		expect(watchers.idlePrompt).not.toBeNull();
		expect(watchers.idlePrompt?.idleSeconds).toBe(11 * 60);
	});

	it("fragt erst wieder, nachdem der Benutzer aktiv war", async () => {
		app.settings.idleThresholdMin = 10;
		timerLaeuftSeit(3600);
		ipc.idleSeconds = 11 * 60;
		await tick();

		// Weggeklickt ("weiterlaufen lassen"), aber immer noch niemand am Rechner.
		watchers.idlePrompt = null;
		await tick(3);
		expect(watchers.idlePrompt).toBeNull();

		// Erst Aktivitaet …
		ipc.idleSeconds = 5;
		await tick();
		expect(watchers.idlePrompt).toBeNull();

		// … dann ist die Frage wieder zulaessig.
		ipc.idleSeconds = 11 * 60;
		await tick();
		expect(watchers.idlePrompt).not.toBeNull();
	});

	it("ist mit Schwelle 0 abgeschaltet", async () => {
		app.settings.idleThresholdMin = 0;
		timerLaeuftSeit(3600);
		ipc.idleSeconds = 5 * 3600;
		await tick();

		expect(watchers.idlePrompt).toBeNull();
		expect(ipc.invoke).not.toHaveBeenCalledWith("idle_seconds");
	});

	it("fragt ohne laufenden Timer gar nicht erst", async () => {
		app.settings.idleThresholdMin = 10;
		ipc.idleSeconds = 11 * 60;
		await tick();

		expect(watchers.idlePrompt).toBeNull();
	});
});

describe("Pomodoro", () => {
	beforeEach(() => {
		app.settings.pomodoroEnabled = true;
		app.settings.pomodoroMin = 50;
		app.settings.pomodoroBreakMin = 10;
	});

	it("meldet sich beim Start eines Timers noch nicht", async () => {
		timerLaeuftSeit(5);
		await tick();

		expect(meldungen.send).not.toHaveBeenCalled();
	});

	it("meldet den Wechsel in die Pause", async () => {
		timerLaeuftSeit(49 * 60);
		await tick();
		meldungen.send.mockClear();

		// Ueber die Fokus-Grenze hinweg.
		app.now = Date.now() + 61 * 1000;
		await tick();

		expect(meldungen.send).toHaveBeenCalledTimes(1);
		expect(meldungen.send.mock.calls[0][0].title).toContain("Pause");
	});

	it("meldet das Ende der Pause", async () => {
		timerLaeuftSeit(59 * 60); // mitten in der Pause
		await tick();
		meldungen.send.mockClear();

		app.now = Date.now() + 61 * 1000; // zurueck in den Fokus
		await tick();

		expect(meldungen.send).toHaveBeenCalledTimes(1);
		expect(meldungen.send.mock.calls[0][0].title).toContain("Weiter");
	});

	it("meldet nichts, wenn die Dauern geaendert werden", async () => {
		// Geaenderte Dauern verschieben den Zyklus – der Sprung darf nicht als
		// Phasenwechsel durchgehen.
		timerLaeuftSeit(49 * 60);
		await tick();
		meldungen.send.mockClear();

		app.settings.pomodoroMin = 25;
		await tick();

		expect(meldungen.send).not.toHaveBeenCalled();
	});

	it("schweigt, solange die Funktion aus ist", async () => {
		app.settings.pomodoroEnabled = false;
		timerLaeuftSeit(49 * 60);
		await tick();
		app.now = Date.now() + 61 * 1000;
		await tick();

		expect(meldungen.send).not.toHaveBeenCalled();
	});
});

describe("Tagesmeldung", () => {
	it("laeuft zu einer festen Stunde und merkt sich den Tag", async () => {
		vi.setSystemTime(new Date(2026, 7, 24, 12, 0, 0));
		app.now = Date.now();
		await tick();

		expect(app.settings.usageLastDay).toBe("2026-08-24");
	});

	it("laeuft ausserhalb der festen Stunden nicht", async () => {
		// STILLE_STUNDE ist 10 Uhr.
		await tick(3);
		expect(app.settings.usageLastDay).toBe("");
	});

	it("laeuft am selben Tag nur einmal", async () => {
		vi.setSystemTime(new Date(2026, 7, 24, 12, 0, 0));
		app.now = Date.now();
		await tick();
		const gespeichert = { ...app.settings };
		const update = vi.spyOn(app, "updateSettings");

		vi.setSystemTime(new Date(2026, 7, 24, 15, 0, 0));
		await tick();

		expect(app.settings.usageLastDay).toBe(gespeichert.usageLastDay);
		expect(update).not.toHaveBeenCalled();
		update.mockRestore();
	});
});

describe("resolveIdle", () => {
	it("kuerzt den Eintrag auf den Beginn des Leerlaufs", async () => {
		const e = timerLaeuftSeit(3600);
		watchers.idlePrompt = { idleStart: Date.now() - 600 * 1000, idleSeconds: 600 };
		const stop = vi.spyOn(app, "stop").mockResolvedValue();

		await resolveIdle("subtract");

		expect(stop).toHaveBeenCalledWith(Date.now() - 600 * 1000);
		expect(watchers.idlePrompt).toBeNull();
		expect(e.endTs).toBeNull(); // stop ist gemockt, der Eintrag bleibt unberuehrt
		stop.mockRestore();
	});

	it("verwirft den Eintrag auf Wunsch ganz", async () => {
		const e = timerLaeuftSeit(3600);
		watchers.idlePrompt = { idleStart: Date.now() - 600 * 1000, idleSeconds: 600 };
		const del = vi.spyOn(app, "deleteEntry").mockResolvedValue();

		await resolveIdle("discard");

		expect(del).toHaveBeenCalledWith(e);
		del.mockRestore();
	});

	it("laesst den Timer bei „weiterlaufen“ unangetastet", async () => {
		timerLaeuftSeit(3600);
		watchers.idlePrompt = { idleStart: Date.now() - 600 * 1000, idleSeconds: 600 };
		const stop = vi.spyOn(app, "stop").mockResolvedValue();
		const del = vi.spyOn(app, "deleteEntry").mockResolvedValue();

		await resolveIdle("keep");

		expect(stop).not.toHaveBeenCalled();
		expect(del).not.toHaveBeenCalled();
		expect(watchers.idlePrompt).toBeNull();
		stop.mockRestore();
		del.mockRestore();
	});
});

describe("resolveLongTimer", () => {
	it("beendet den Timer zur eingegebenen Zeit", async () => {
		timerLaeuftSeit(11 * 3600);
		const ende = Date.now() - 3600 * 1000;
		watchers.longTimerPrompt = {
			activityId: P1,
			startTs: Date.now() - 11 * 3600 * 1000,
			elapsedSec: 11 * 3600
		};
		const stop = vi.spyOn(app, "stop").mockResolvedValue();

		await resolveLongTimer("stop", ende);

		expect(stop).toHaveBeenCalledWith(ende);
		stop.mockRestore();
	});

	it("laesst keine Endzeit vor dem Beginn zu", async () => {
		const start = Date.now() - 11 * 3600 * 1000;
		timerLaeuftSeit(11 * 3600);
		watchers.longTimerPrompt = { activityId: P1, startTs: start, elapsedSec: 11 * 3600 };
		const stop = vi.spyOn(app, "stop").mockResolvedValue();

		await resolveLongTimer("stop", start - 5 * 3600 * 1000);

		expect(stop).toHaveBeenCalledWith(start);
		stop.mockRestore();
	});

	it("laesst keine Endzeit in der Zukunft zu", async () => {
		timerLaeuftSeit(11 * 3600);
		watchers.longTimerPrompt = {
			activityId: P1,
			startTs: Date.now() - 11 * 3600 * 1000,
			elapsedSec: 11 * 3600
		};
		const stop = vi.spyOn(app, "stop").mockResolvedValue();

		await resolveLongTimer("stop", Date.now() + 5 * 3600 * 1000);

		expect(stop).toHaveBeenCalledWith(Date.now());
		stop.mockRestore();
	});

	it("tut bei „weiterlaufen“ nichts", async () => {
		timerLaeuftSeit(11 * 3600);
		watchers.longTimerPrompt = {
			activityId: P1,
			startTs: Date.now() - 11 * 3600 * 1000,
			elapsedSec: 11 * 3600
		};
		const stop = vi.spyOn(app, "stop").mockResolvedValue();

		await resolveLongTimer("keep");

		expect(stop).not.toHaveBeenCalled();
		expect(watchers.longTimerPrompt).toBeNull();
		stop.mockRestore();
	});
});
