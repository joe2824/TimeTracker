import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Activity, Entry } from "../types";
import { defaultSettings } from "../types";
import { files, resetFakeFs } from "../testing/fakeFs";
import { fmtDate, monthKey } from "../time/time";
import { suggestLongTimerEnd } from "../time/longTimer";

vi.mock("@tauri-apps/plugin-fs", async () => (await import("../testing/fakeFs")).fakeFs);
vi.mock("svelte-sonner", () => import("../testing/toastStub"));

/**
 * IPC-Ersatz. `idle_seconds` liefert, was der jeweilige Test vorgibt – ohne das
 * hängt die Leerlauf-Erkennung an der echten Tastatur der Maschine, auf der die
 * Suite gerade läuft.
 */
const ipc = vi.hoisted(() => ({
	idleSeconds: 0,
	invoke: vi.fn()
}));
ipc.invoke.mockImplementation(async (cmd: string) => (cmd === "idle_seconds" ? ipc.idleSeconds : undefined));
vi.mock("@tauri-apps/api/core", () => ({ invoke: ipc.invoke }));

const messages = vi.hoisted(() => ({ send: vi.fn() }));
// Gemeldet wird über platform/notify - die Hülle dahinter (Rust-Command oder
// Web-Notification) ist hier nicht der Gegenstand und läuft unter vitest ohnehin
// in keine der beiden Äste.
vi.mock("../platform/notify", () => ({
	notify: messages.send,
	ensureNotificationPermission: async () => true
}));
// Die Berechtigung ist hier nicht der Gegenstand: immer erteilt.
vi.mock("./reminders", () => ({ ensureNotificationPermission: async () => true }));

// Die Tagesmeldung geht sonst wirklich ins Netz. Der Rückgabewert entscheidet,
// ob der Tag als gemeldet gilt - genau darum geht es unten. Die Adresse zählt
// mit: an ihr hängt, welchem Server eine Absage gilt.
const telemetry = vi.hoisted(() => ({ ping: vi.fn() }));
const accountMock = vi.hoisted(() => ({
	addLogoutHook: () => {},
	serverUrl: "https://tracker.example.de",
	// Im Wächter zählt das Ziel der Meldung, nicht die Verknüpfung: ohne Konto
	// steht dort der Server aus dem Build. Welcher es ist, entscheidet das Konto -
	// hier genügt, dass beides dieselbe Adresse ist.
	get usagePingServer() {
		return this.serverUrl;
	},
	sendUsagePing: vi.fn()
}));
vi.mock("../sync/account.svelte", () => ({ account: accountMock }));

const { app } = await import("../app.svelte");
const {
	resolveIdle,
	resolveLongTimer,
	startUsagePing,
	startWatchers,
	stopUsagePing,
	stopWatchers,
	watchers
} = await import("./watchers.svelte");

const P1 = "p1";
const P2 = "p2";
const ACTIVITIES_DE: Activity[] = [
	{ id: P1, name: "Projekt 1", sortOrder: 0, archived: false, isAbsence: false },
	{ id: P2, name: "Projekt 2", sortOrder: 1, archived: false, isAbsence: false }
];

import { appTimeZone, wallStringToTs } from "../time/tz";

/** Ausgangszeit aller Tests - ein gewöhnlicher Vormittag. */
const START_TIME = new Date(wallStringToTs("2026-08-24", "10:00"));

function ongoing(startTs: number, activityId = P1): Entry {
	return { id: `r-${startTs}-${activityId}`, activityId, startTs, endTs: null, note: "", source: "timer" };
}

/** Einen laufenden Timer einhängen, der vor `sekunden` begonnen hat. */
function timerRunningSince(seconds: number, activityId = P1): Entry {
	const start = Date.now() - seconds * 1000;
	const e = ongoing(start, activityId);
	app.entriesByMonth[monthKey(start)] = [e];
	app.running = e;
	app.now = Date.now();
	return e;
}

/** Einen Sekundentakt des Wächters durchlaufen lassen. */
async function tick(n = 1) {
	await vi.advanceTimersByTimeAsync(1000 * n);
}

/** Die Tagesmeldung läuft im Minutentakt, nicht im Sekundentakt. */
async function tickPing(n = 1) {
	await vi.advanceTimersByTimeAsync(60_000 * n);
}

beforeEach(async () => {
	resetFakeFs();
	vi.useFakeTimers();
	vi.setSystemTime(START_TIME);
	app.dispose();
	app.settings = { ...defaultSettings };
	app.activities = [...ACTIVITIES_DE];
	app.running = null;
	app.entriesByMonth = {};
	app.now = Date.now();
	watchers.idlePrompt = null;
	watchers.longTimerPrompt = null;
	ipc.idleSeconds = 0;
	ipc.invoke.mockClear();
	messages.send.mockClear();
	accountMock.sendUsagePing.mockReset();
	accountMock.sendUsagePing.mockResolvedValue("sent");
	accountMock.serverUrl = "https://tracker.example.de";

	// Einen Takt ohne laufenden Timer: der setzt die modulinternen Merker zurück,
	// die sonst aus dem vorigen Test stehen blieben (sie leben am Modul, nicht am
	// Zustand). Erst danach beginnt der eigentliche Fall.
	startWatchers();
	await tick();
	ipc.invoke.mockClear();
	messages.send.mockClear();
});

afterEach(() => {
	stopWatchers();
	stopUsagePing();
	vi.useRealTimers();
});

describe("Tray-Tooltip", () => {
	it("meldet Aktivitaet und laufende Zeit", async () => {
		timerRunningSince(3661); // 1:01:01
		await tick();

		expect(ipc.invoke).toHaveBeenCalledWith("set_tray_tooltip", {
			text: "Projekt 1 – 1:01:01"
		});
	});

	it("schickt bei unveraenderter Anzeige nichts ueber die Bruecke", async () => {
		timerRunningSince(10);
		await tick();
		ipc.invoke.mockClear();

		// Zweiter Takt, ohne dass app.now weiterläuft: gleiche Anzeige.
		await tick();

		const tooltips = ipc.invoke.mock.calls.filter(([cmd]) => cmd === "set_tray_tooltip");
		expect(tooltips).toHaveLength(0);
	});

	it("faellt beim Stoppen auf den blanken Namen zurueck", async () => {
		timerRunningSince(10);
		await tick();
		app.running = null;
		await tick();

		expect(ipc.invoke).toHaveBeenLastCalledWith("set_tray_tooltip", { text: "TimeTracker" });
	});
});

describe("Auto-Stop-Warnung", () => {
	it("meldet einen Timer, der laenger als die Grenze laeuft", async () => {
		app.settings.maxTimerHours = 10;
		timerRunningSince(10 * 3600 + 5);
		await tick();

		expect(watchers.longTimerPrompt).toMatchObject({ activityId: P1 });
		expect(messages.send).toHaveBeenCalledTimes(1);
	});

	it("meldet denselben Lauf kein zweites Mal", async () => {
		app.settings.maxTimerHours = 10;
		timerRunningSince(10 * 3600 + 5);
		await tick();
		// Der Benutzer klickt die Rückfrage weg, der Timer läuft weiter.
		watchers.longTimerPrompt = null;
		messages.send.mockClear();

		await tick(5);

		expect(watchers.longTimerPrompt).toBeNull();
		expect(messages.send).not.toHaveBeenCalled();
	});

	it("stellt die Warnung bei einem Aktivitaetswechsel wieder scharf", async () => {
		app.settings.maxTimerHours = 10;
		timerRunningSince(10 * 3600 + 5);
		await tick();
		watchers.longTimerPrompt = null;
		messages.send.mockClear();

		// Anderer Lauf, ebenfalls über der Grenze.
		timerRunningSince(10 * 3600 + 5, P2);
		await tick();

		expect(watchers.longTimerPrompt).toMatchObject({ activityId: P2 });
		expect(messages.send).toHaveBeenCalledTimes(1);
	});

	it("ist mit maxTimerHours = 0 abgeschaltet", async () => {
		app.settings.maxTimerHours = 0;
		timerRunningSince(50 * 3600);
		await tick();

		expect(watchers.longTimerPrompt).toBeNull();
		expect(messages.send).not.toHaveBeenCalled();
	});

	it("zaehlt den ganzen Lauf, nicht nur das Stueck seit Mitternacht", async () => {
		// Ein über Mitternacht geteilter Lauf: zwei Einträge, die aneinander
		// stossen. Zählte die Warnung nur das letzte Stück, meldete sie sich bei
		// einem vergessenen Timer jeden Tag aufs Neue.
		// Die Grenze liegt bewusst ZWISCHEN beiden Zeitspannen: das laufende Stück
		// ist 10 Stunden alt, der ganze Lauf 18. Nur so fällt auf, wenn hier
		// wieder das letzte Stück gezählt wird – bei einer Grenze unter 10 Stunden
		// schlüge beides an und der Test bewiese nichts.
		app.settings.maxTimerHours = 12;
		const midnight = wallStringToTs("2026-08-24", "00:00");
		const yesterday = ongoing(midnight - 8 * 3600 * 1000);
		yesterday.endTs = midnight;
		const today = ongoing(midnight);
		app.entriesByMonth[monthKey(midnight)] = [yesterday, today];
		app.running = today;
		app.now = Date.now(); // 10 Uhr, siehe STILLE_STUNDE

		await tick();

		expect(watchers.longTimerPrompt?.startTs).toBe(yesterday.startTs);
	});
});

describe("Leerlauf-Erkennung", () => {
	it("fragt nach, sobald die Schwelle ueberschritten ist", async () => {
		app.settings.idleThresholdMin = 10;
		timerRunningSince(3600);
		ipc.idleSeconds = 11 * 60;
		await tick();

		expect(watchers.idlePrompt).not.toBeNull();
		expect(watchers.idlePrompt?.idleSeconds).toBe(11 * 60);
	});

	it("fragt erst wieder, nachdem der Benutzer aktiv war", async () => {
		app.settings.idleThresholdMin = 10;
		timerRunningSince(3600);
		ipc.idleSeconds = 11 * 60;
		await tick();

		// Weggeklickt ("weiterlaufen lassen"), aber immer noch niemand am Rechner.
		watchers.idlePrompt = null;
		await tick(3);
		expect(watchers.idlePrompt).toBeNull();

		// Erst Aktivität …
		ipc.idleSeconds = 5;
		await tick();
		expect(watchers.idlePrompt).toBeNull();

		// … dann ist die Frage wieder zulässig.
		ipc.idleSeconds = 11 * 60;
		await tick();
		expect(watchers.idlePrompt).not.toBeNull();
	});

	it("ist mit Schwelle 0 abgeschaltet", async () => {
		app.settings.idleThresholdMin = 0;
		timerRunningSince(3600);
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
		timerRunningSince(5);
		await tick();

		expect(messages.send).not.toHaveBeenCalled();
	});

	it("meldet den Wechsel in die Pause", async () => {
		timerRunningSince(49 * 60);
		await tick();
		messages.send.mockClear();

		// Über die Fokus-Grenze hinweg.
		app.now = Date.now() + 61 * 1000;
		await tick();

		expect(messages.send).toHaveBeenCalledTimes(1);
		expect(messages.send.mock.calls[0][0].title).toContain("Pause");
	});

	it("meldet das Ende der Pause", async () => {
		timerRunningSince(59 * 60); // mitten in der Pause
		await tick();
		messages.send.mockClear();

		app.now = Date.now() + 61 * 1000; // zurück in den Fokus
		await tick();

		expect(messages.send).toHaveBeenCalledTimes(1);
		expect(messages.send.mock.calls[0][0].title).toContain("Weiter");
	});

	it("meldet nichts, wenn die Dauern geaendert werden", async () => {
		// Geänderte Dauern verschieben den Zyklus – der Sprung darf nicht als
		// Phasenwechsel durchgehen.
		timerRunningSince(49 * 60);
		await tick();
		messages.send.mockClear();

		app.settings.pomodoroMin = 25;
		await tick();

		expect(messages.send).not.toHaveBeenCalled();
	});

	it("schweigt, solange die Funktion aus ist", async () => {
		app.settings.pomodoroEnabled = false;
		timerRunningSince(49 * 60);
		await tick();
		app.now = Date.now() + 61 * 1000;
		await tick();

		expect(messages.send).not.toHaveBeenCalled();
	});
});

describe("Tagesmeldung", () => {
	/**
	 * Den Lauf zu einer Uhrzeit starten und die sofortige Meldung durchlaufen
	 * lassen. Gestartet wird hier und nicht im globalen beforeEach: die erste
	 * Meldung ist selbst der Gegenstand.
	 */
	async function startPingAt(wall: string) {
		vi.setSystemTime(wallStringToTs("2026-08-24", wall));
		app.now = Date.now();
		startUsagePing();
		await vi.advanceTimersByTimeAsync(0);
	}

	it("meldet sofort beim Start und merkt sich den Tag", async () => {
		await startPingAt("12:00");

		expect(accountMock.sendUsagePing).toHaveBeenCalledTimes(1);
		expect(app.settings.usageLastDay).toBe("2026-08-24");
	});

	// Wer die App nur kurz zwischen zwei Terminen aufmacht, soll zählen. Feste
	// Meldestunden liessen genau diesen Fall durchfallen.
	it("meldet zu jeder Uhrzeit", async () => {
		await startPingAt("03:17");

		expect(accountMock.sendUsagePing).toHaveBeenCalledTimes(1);
		expect(app.settings.usageLastDay).toBe("2026-08-24");
	});

	// Vorher wurde der Tag auch dann vermerkt, wenn der Server den Ping gar nicht
	// angenommen hatte - das Gerät fiel damit ersatzlos aus der Zählung.
	it("vermerkt den Tag nicht, wenn der Ping nicht ankam", async () => {
		accountMock.sendUsagePing.mockResolvedValue("retry");
		await startPingAt("12:00");

		expect(accountMock.sendUsagePing).toHaveBeenCalledTimes(1);
		expect(app.settings.usageLastDay).toBe("");
	});

	// Ohne Sperre hämmerte ein abgewiesener Ping im Takt der Prüfung gegen den
	// Server.
	it("wiederholt einen abgewiesenen Ping erst nach einer Wartezeit", async () => {
		accountMock.sendUsagePing.mockResolvedValue("retry");
		const noon = wallStringToTs("2026-08-24", "12:00");
		await startPingAt("12:00");
		expect(accountMock.sendUsagePing).toHaveBeenCalledTimes(1);

		// Eine Minute später: noch gesperrt.
		vi.setSystemTime(noon + 60_000);
		await tickPing(3);
		expect(accountMock.sendUsagePing).toHaveBeenCalledTimes(1);

		// Nach fünf Minuten wieder erlaubt - diesmal nimmt der Server ihn an.
		await retryAccepted(noon);
	});

	/** Nach der Wartezeit noch einmal - und diesmal nimmt der Server ihn an. */
	async function retryAccepted(noon: number): Promise<void> {
		accountMock.sendUsagePing.mockResolvedValue("sent");
		vi.setSystemTime(noon + 6 * 60_000);
		await tickPing();
		expect(accountMock.sendUsagePing).toHaveBeenCalledTimes(2);
		expect(app.settings.usageLastDay).toBe("2026-08-24");
	}

	/** Ein erster Ping um 12:00, den der Server ablehnt. Gibt 12:00 zurück. */
	async function declinedAtNoon(): Promise<number> {
		accountMock.sendUsagePing.mockResolvedValue("declined");
		await startPingAt("12:00");
		expect(accountMock.sendUsagePing).toHaveBeenCalledTimes(1);
		return wallStringToTs("2026-08-24", "12:00");
	}

	// Ein älterer Server kennt den Endpunkt nicht und antwortet dauerhaft mit
	// 404. Ohne diesen Riegel klopfte jedes Gerät alle fünf Minuten an - hinter
	// einer gemeinsamen Adresse bis die Bremse anschlägt.
	it("fragt nicht weiter, wenn der Server die Meldung ablehnt", async () => {
		const noon = await declinedAtNoon();

		// Auch nach der Wartezeit und in der nächsten Stunde kein zweiter Versuch.
		vi.setSystemTime(noon + 10 * 60_000);
		await tickPing(3);
		vi.setSystemTime(wallStringToTs("2026-08-24", "15:00"));
		await tickPing(3);

		expect(accountMock.sendUsagePing).toHaveBeenCalledTimes(1);
		expect(app.settings.usageLastDay).toBe("");
	});

	// Die Absage gilt dem Server, nicht dem Programmlauf: wer sich danach mit
	// einem anderen verknüpft, soll dort wieder zählen dürfen.
	it("fragt nach einem Serverwechsel wieder", async () => {
		const noon = await declinedAtNoon();

		accountMock.serverUrl = "https://anderer.example.de";
		await retryAccepted(noon);
	});

	// Nicht jeder Fehlschlag heilt: ein falscher Schlüssel bleibt falsch. Ohne
	// Deckel klopfte so ein Gerät alle fünf Minuten weiter.
	it("hoert nach fuenf vergeblichen Versuchen in dieser Stunde auf", async () => {
		accountMock.sendUsagePing.mockResolvedValue("retry");
		const noon = wallStringToTs("2026-08-24", "12:00");
		await startPingAt("12:00");

		// Sechs weitere Anläufe im Abstand der Wartezeit - nur vier dürfen durch.
		for (let i = 1; i < 7; i++) {
			vi.setSystemTime(noon + i * 6 * 60_000);
			await tickPing();
		}

		expect(accountMock.sendUsagePing).toHaveBeenCalledTimes(5);
		expect(app.settings.usageLastDay).toBe("");
	});

	// Das Budget gilt je Stunde. Sonst brennt eine halbe Stunde ohne Netz um
	// 9 Uhr den ganzen Tag ab, obwohl das Gerät um 12 längst wieder da ist.
	it("bekommt zur naechsten Stunde ein neues Budget", async () => {
		accountMock.sendUsagePing.mockResolvedValue("retry");
		const nine = wallStringToTs("2026-08-24", "09:00");
		await startPingAt("09:00");
		for (let i = 1; i < 7; i++) {
			vi.setSystemTime(nine + i * 6 * 60_000);
			await tickPing();
		}
		expect(accountMock.sendUsagePing).toHaveBeenCalledTimes(5);

		// Wieder online, nächste Stunde.
		accountMock.sendUsagePing.mockResolvedValue("sent");
		vi.setSystemTime(wallStringToTs("2026-08-24", "12:00"));
		await tickPing();

		expect(accountMock.sendUsagePing).toHaveBeenCalledTimes(6);
		expect(app.settings.usageLastDay).toBe("2026-08-24");
	});

	// Ohne verknüpftes Konto gibt es nichts zu melden - und nichts, was das
	// Budget verbrauchen dürfte. Wer sich um 10 Uhr verknüpft, zählt danach.
	it("verbraucht ohne verknuepftes Konto kein Budget", async () => {
		accountMock.serverUrl = "";
		const nine = wallStringToTs("2026-08-24", "09:00");
		await startPingAt("09:00");
		for (let i = 1; i < 7; i++) {
			vi.setSystemTime(nine + i * 6 * 60_000);
			await tickPing();
		}
		expect(accountMock.sendUsagePing).not.toHaveBeenCalled();

		// Jetzt verknüpft, dieselbe Stunde.
		accountMock.serverUrl = "https://tracker.example.de";
		vi.setSystemTime(nine + 8 * 6 * 60_000);
		await tickPing();

		expect(accountMock.sendUsagePing).toHaveBeenCalledTimes(1);
		expect(app.settings.usageLastDay).toBe("2026-08-24");
	});

	it("laeuft am selben Tag nur einmal", async () => {
		await startPingAt("12:00");
		const saved = { ...app.settings };
		const update = vi.spyOn(app, "updateSettings");

		vi.setSystemTime(wallStringToTs("2026-08-24", "15:00"));
		await tickPing();

		expect(app.settings.usageLastDay).toBe(saved.usageLastDay);
		expect(update).not.toHaveBeenCalled();
		update.mockRestore();
	});
});

describe("resolveIdle", () => {
	it("kuerzt den Eintrag auf den Beginn des Leerlaufs", async () => {
		const e = timerRunningSince(3600);
		watchers.idlePrompt = { idleStart: Date.now() - 600 * 1000, idleSeconds: 600 };
		const stop = vi.spyOn(app, "stop").mockResolvedValue();

		await resolveIdle("subtract");

		expect(stop).toHaveBeenCalledWith(Date.now() - 600 * 1000);
		expect(watchers.idlePrompt).toBeNull();
		expect(e.endTs).toBeNull(); // stop ist gemockt, der Eintrag bleibt unberührt
		stop.mockRestore();
	});

	it("verwirft den Eintrag auf Wunsch ganz", async () => {
		const e = timerRunningSince(3600);
		watchers.idlePrompt = { idleStart: Date.now() - 600 * 1000, idleSeconds: 600 };
		const del = vi.spyOn(app, "deleteEntry").mockResolvedValue();

		await resolveIdle("discard");

		expect(del).toHaveBeenCalledWith(e);
		del.mockRestore();
	});

	it("laesst den Timer bei „weiterlaufen“ unangetastet", async () => {
		timerRunningSince(3600);
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
		timerRunningSince(11 * 3600);
		const end = Date.now() - 3600 * 1000;
		watchers.longTimerPrompt = {
			activityId: P1,
			startTs: Date.now() - 11 * 3600 * 1000,
			elapsedSec: 11 * 3600
		};
		const stop = vi.spyOn(app, "stop").mockResolvedValue();

		await resolveLongTimer("stop", end);

		expect(stop).toHaveBeenCalledWith(end);
		stop.mockRestore();
	});

	it("laesst keine Endzeit vor dem Beginn zu", async () => {
		const start = Date.now() - 11 * 3600 * 1000;
		timerRunningSince(11 * 3600);
		watchers.longTimerPrompt = { activityId: P1, startTs: start, elapsedSec: 11 * 3600 };
		const stop = vi.spyOn(app, "stop").mockResolvedValue();

		await resolveLongTimer("stop", start - 5 * 3600 * 1000);

		expect(stop).toHaveBeenCalledWith(start);
		stop.mockRestore();
	});

	it("laesst keine Endzeit in der Zukunft zu", async () => {
		timerRunningSince(11 * 3600);
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
		timerRunningSince(11 * 3600);
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

describe("Timer übers Wochenende, am Montag im Dialog auf Freitag beendet", () => {
	const MONDAY = "2026-08-24";
	const FRIDAY = "2026-08-21";
	const wall = (date: string, time: string) => wallStringToTs(date, time);
	const monthFile = (m: string) => `data/entries-${m}.json`;
	const onDisk = (m: string): Entry[] => JSON.parse(files.get(monthFile(m)) ?? "[]");
	const timerEntry = (id: string, startTs: number, endTs: number | null): Entry => ({
		id,
		activityId: P1,
		startTs,
		endTs,
		note: "",
		source: "timer"
	});

	/** Die App startet am Montag frisch – mit diesem Stand auf der Platte. */
	function startMonday(time: string, byMonth: Record<string, Entry[]>) {
		return startOn(MONDAY, time, byMonth);
	}

	async function startOn(date: string, time: string, byMonth: Record<string, Entry[]>) {
		vi.setSystemTime(new Date(wall(date, time)));
		// currentMonth hängt an app.now: sonst lüde init() die Monate des Vortests.
		app.now = Date.now();
		files.set(
			"data/settings.json",
			JSON.stringify({ ...defaultSettings, timeZone: appTimeZone(), maxTimerHours: 10 })
		);
		files.set("data/activities.json", JSON.stringify(ACTIVITIES_DE));
		for (const [m, list] of Object.entries(byMonth)) files.set(monthFile(m), JSON.stringify(list));
		app.entriesByMonth = {};
		app.running = null;
		app.loaded = false;
		expect(await app.init()).toBe(true);
		// Ein paar Takte: Mitternachts-Wechsel und Wächter laufen an.
		await tick(3);
	}

	/** Was der Dialog vorbelegt – dieselbe Rechnung wie in LongTimerDialog. */
	function dialogSuggestion(): number {
		const p = watchers.longTimerPrompt!;
		const dayStart = app
			.monthEntries(monthKey(p.startTs))
			.filter((e) => fmtDate(e.startTs) === fmtDate(p.startTs))
			.reduce((min, e) => Math.min(min, e.startTs), Infinity);
		return suggestLongTimerEnd({
			runStartTs: p.startTs,
			now: Date.now(),
			dayStartTs: Number.isFinite(dayStart) ? dayStart : null,
			hoursPerDay: app.settings.hoursPerDay,
			deductBreaks: app.settings.breakDeduction
		});
	}

	/** Alle Einträge ab Freitag, über alle Monatsdateien. */
	function fromFriday(friday: string): Entry[] {
		const from = wall(friday, "00:00");
		return [...files.keys()]
			.filter((k) => k.startsWith("data/entries-"))
			.flatMap((k) => JSON.parse(files.get(k)!) as Entry[])
			.filter((e) => e.startTs >= from)
			.sort((a, b) => a.startTs - b.startTs);
	}

	afterEach(() => app.dispose());

	it("Rechner schlief übers Wochenende: nur der Freitag bleibt", async () => {
		await startMonday("08:30", { "2026-08": [timerEntry("fr", wall(FRIDAY, "08:00"), null)] });

		// Der Wechsel hat Sa, So und den laufenden Montag angelegt …
		expect(app.running?.startTs).toBe(wall(MONDAY, "00:00"));
		// … und der Dialog fragt nach dem ganzen Lauf, ab Freitag.
		expect(watchers.longTimerPrompt?.startTs).toBe(wall(FRIDAY, "08:00"));
		const end = dialogSuggestion();
		expect(fmtDate(end)).toBe(FRIDAY);

		await resolveLongTimer("stop", end);

		expect(fromFriday(FRIDAY).map((e) => [e.startTs, e.endTs])).toEqual([[wall(FRIDAY, "08:00"), end]]);
		expect(app.running).toBeNull();
	});

	it("App lief übers Wochenende durch: nur der Freitag bleibt", async () => {
		await startMonday("08:30", {
			"2026-08": [
				timerEntry("fr", wall(FRIDAY, "08:00"), wall("2026-08-22", "00:00")),
				timerEntry("sa", wall("2026-08-22", "00:00"), wall("2026-08-23", "00:00")),
				timerEntry("so", wall("2026-08-23", "00:00"), wall(MONDAY, "00:00")),
				timerEntry("mo", wall(MONDAY, "00:00"), null)
			]
		});

		expect(watchers.longTimerPrompt?.startTs).toBe(wall(FRIDAY, "08:00"));
		await resolveLongTimer("stop", wall(FRIDAY, "17:00"));

		expect(fromFriday(FRIDAY).map((e) => e.id)).toEqual(["fr"]);
		expect(onDisk("2026-08").find((e) => e.id === "fr")?.endTs).toBe(wall(FRIDAY, "17:00"));
	});

	it("anderes Gerät hatte schon geteilt: auch dessen Sa und So verschwinden", async () => {
		// Der Stand vom Montagmorgen: der Rechner kennt nur den offenen Freitag,
		// der Abgleich hat Sa und den offenen So eines anderen Geräts dazugelegt.
		await startMonday("08:30", {
			"2026-08": [
				timerEntry("fr", wall(FRIDAY, "08:00"), null),
				timerEntry("sa-r", wall("2026-08-22", "00:00"), wall("2026-08-23", "00:00")),
				timerEntry("so-r", wall("2026-08-23", "00:00"), null)
			]
		});

		expect(watchers.longTimerPrompt?.startTs).toBe(wall(FRIDAY, "08:00"));
		await resolveLongTimer("stop", wall(FRIDAY, "17:00"));

		expect(fromFriday(FRIDAY).map((e) => [e.startTs, e.endTs])).toEqual([
			[wall(FRIDAY, "08:00"), wall(FRIDAY, "17:00")]
		]);
	});

	it("wie am 28.09.: Sa und So doppelt, weil zwei Geräte geteilt haben", async () => {
		// Der Stand aus dem Protokoll kurz vor dem Beenden: dieser Rechner und ein
		// anderes Gerät haben den Lauf je selbst geteilt, dessen offener Sonntag
		// wurde beim Laden geschätzt geschlossen.
		const sa = wall("2026-08-22", "00:00");
		const so = wall("2026-08-23", "00:00");
		const mo = wall(MONDAY, "00:00");
		await startMonday("08:39", {
			"2026-08": [
				timerEntry("fr", wall(FRIDAY, "08:00"), sa),
				timerEntry("sa-l", sa, so),
				timerEntry("so-l", so, mo),
				timerEntry("sa-r", sa, so),
				timerEntry("so-r", so, mo),
				timerEntry("mo-l", mo, null)
			]
		});

		expect(watchers.longTimerPrompt?.startTs).toBe(wall(FRIDAY, "08:00"));
		await resolveLongTimer("stop", wall(FRIDAY, "21:00"));

		expect(fromFriday(FRIDAY).map((e) => [e.startTs, e.endTs])).toEqual([
			[wall(FRIDAY, "08:00"), wall(FRIDAY, "21:00")]
		]);
	});

	it("Wochenende über die Monatsgrenze: auch der neue Monat bleibt leer", async () => {
		const friday = "2026-07-31";
		await startOn("2026-08-03", "08:30", { "2026-07": [timerEntry("fr", wall(friday, "08:00"), null)] });

		expect(watchers.longTimerPrompt?.startTs).toBe(wall(friday, "08:00"));
		const end = dialogSuggestion();
		expect(fmtDate(end)).toBe(friday);
		await resolveLongTimer("stop", end);

		expect(fromFriday(friday).map((e) => [e.startTs, e.endTs])).toEqual([[wall(friday, "08:00"), end]]);
		expect(onDisk("2026-08")).toEqual([]);
	});

	it("Ende am Samstag: Freitag bis Mitternacht, Samstag bis zur Endzeit, Sonntag weg", async () => {
		await startMonday("08:30", { "2026-08": [timerEntry("fr", wall(FRIDAY, "08:00"), null)] });

		await resolveLongTimer("stop", wall("2026-08-22", "02:00"));

		expect(fromFriday(FRIDAY).map((e) => [e.startTs, e.endTs])).toEqual([
			[wall(FRIDAY, "08:00"), wall("2026-08-22", "00:00")],
			[wall("2026-08-22", "00:00"), wall("2026-08-22", "02:00")]
		]);
	});
});
