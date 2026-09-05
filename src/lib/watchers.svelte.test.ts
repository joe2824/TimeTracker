import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Activity, Entry } from "./types";
import { defaultSettings } from "./types";
import { resetFakeFs } from "./testing/fakeFs";
import { monthKey } from "./time";

vi.mock("@tauri-apps/plugin-fs", async () => (await import("./testing/fakeFs")).fakeFs);
vi.mock("svelte-sonner", () => import("./testing/toastStub"));

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

const messages = vi.hoisted(() => ({ send: vi.fn() }));
// Gemeldet wird ueber platform/notify - die Huelle dahinter (Tauri-Plugin oder
// Web-Notification) ist hier nicht der Gegenstand und laeuft unter vitest ohnehin
// in keine der beiden Aeste.
vi.mock("./platform/notify", () => ({
	notify: messages.send,
	ensureNotificationPermission: async () => true,
	installNotificationClickListener: async () => () => {}
}));
// Die Berechtigung ist hier nicht der Gegenstand: immer erteilt.
vi.mock("./reminders", () => ({ ensureNotificationPermission: async () => true }));

// Die Tagesmeldung geht sonst wirklich ins Netz. Der Rueckgabewert entscheidet,
// ob der Tag als gemeldet gilt - genau darum geht es unten. Die Adresse zaehlt
// mit: an ihr haengt, welchem Server eine Absage gilt.
const telemetry = vi.hoisted(() => ({ ping: vi.fn() }));
const accountMock = vi.hoisted(() => ({
	serverUrl: "https://tracker.example.de",
	// Im Waechter zaehlt das Ziel der Meldung, nicht die Verknuepfung: ohne Konto
	// steht dort der Server aus dem Build. Welcher es ist, entscheidet das Konto -
	// hier genuegt, dass beides dieselbe Adresse ist.
	get usagePingServer() {
		return this.serverUrl;
	},
	sendUsagePing: vi.fn()
}));
vi.mock("./sync/account.svelte", () => ({ account: accountMock }));

const { app } = await import("./app.svelte");
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

import { wallStringToTs } from "./tz";

/** Ausgangszeit aller Tests - ein gewoehnlicher Vormittag. */
const START_TIME = new Date(wallStringToTs("2026-08-24", "10:00"));

function ongoing(startTs: number, activityId = P1): Entry {
	return { id: `r-${startTs}-${activityId}`, activityId, startTs, endTs: null, note: "", source: "timer" };
}

/** Einen laufenden Timer einhaengen, der vor `sekunden` begonnen hat. */
function timerRunningSince(seconds: number, activityId = P1): Entry {
	const start = Date.now() - seconds * 1000;
	const e = ongoing(start, activityId);
	app.entriesByMonth[monthKey(start)] = [e];
	app.running = e;
	app.now = Date.now();
	return e;
}

/** Einen Sekundentakt des Waechters durchlaufen lassen. */
async function tick(n = 1) {
	await vi.advanceTimersByTimeAsync(1000 * n);
}

/** Die Tagesmeldung laeuft im Minutentakt, nicht im Sekundentakt. */
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

	// Einen Takt ohne laufenden Timer: der setzt die modulinternen Merker zurueck,
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

		// Zweiter Takt, ohne dass app.now weiterlaeuft: gleiche Anzeige.
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
		// Der Benutzer klickt die Rueckfrage weg, der Timer laeuft weiter.
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

		// Anderer Lauf, ebenfalls ueber der Grenze.
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
		// Ein ueber Mitternacht geteilter Lauf: zwei Eintraege, die aneinander
		// stossen. Zaehlte die Warnung nur das letzte Stueck, meldete sie sich bei
		// einem vergessenen Timer jeden Tag aufs Neue.
		// Die Grenze liegt bewusst ZWISCHEN beiden Zeitspannen: das laufende Stueck
		// ist 10 Stunden alt, der ganze Lauf 18. Nur so faellt auf, wenn hier
		// wieder das letzte Stueck gezaehlt wird – bei einer Grenze unter 10 Stunden
		// schluege beides an und der Test bewiese nichts.
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

		// Ueber die Fokus-Grenze hinweg.
		app.now = Date.now() + 61 * 1000;
		await tick();

		expect(messages.send).toHaveBeenCalledTimes(1);
		expect(messages.send.mock.calls[0][0].title).toContain("Pause");
	});

	it("meldet das Ende der Pause", async () => {
		timerRunningSince(59 * 60); // mitten in der Pause
		await tick();
		messages.send.mockClear();

		app.now = Date.now() + 61 * 1000; // zurueck in den Fokus
		await tick();

		expect(messages.send).toHaveBeenCalledTimes(1);
		expect(messages.send.mock.calls[0][0].title).toContain("Weiter");
	});

	it("meldet nichts, wenn die Dauern geaendert werden", async () => {
		// Geaenderte Dauern verschieben den Zyklus – der Sprung darf nicht als
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

	// Wer die App nur kurz zwischen zwei Terminen aufmacht, soll zaehlen. Feste
	// Meldestunden liessen genau diesen Fall durchfallen.
	it("meldet zu jeder Uhrzeit", async () => {
		await startPingAt("03:17");

		expect(accountMock.sendUsagePing).toHaveBeenCalledTimes(1);
		expect(app.settings.usageLastDay).toBe("2026-08-24");
	});

	// Vorher wurde der Tag auch dann vermerkt, wenn der Server den Ping gar nicht
	// angenommen hatte - das Geraet fiel damit ersatzlos aus der Zaehlung.
	it("vermerkt den Tag nicht, wenn der Ping nicht ankam", async () => {
		accountMock.sendUsagePing.mockResolvedValue("retry");
		await startPingAt("12:00");

		expect(accountMock.sendUsagePing).toHaveBeenCalledTimes(1);
		expect(app.settings.usageLastDay).toBe("");
	});

	// Ohne Sperre haemmerte ein abgewiesener Ping im Takt der Pruefung gegen den
	// Server.
	it("wiederholt einen abgewiesenen Ping erst nach einer Wartezeit", async () => {
		accountMock.sendUsagePing.mockResolvedValue("retry");
		const zwoelf = wallStringToTs("2026-08-24", "12:00");
		await startPingAt("12:00");
		expect(accountMock.sendUsagePing).toHaveBeenCalledTimes(1);

		// Eine Minute spaeter: noch gesperrt.
		vi.setSystemTime(zwoelf + 60_000);
		await tickPing(3);
		expect(accountMock.sendUsagePing).toHaveBeenCalledTimes(1);

		// Nach fuenf Minuten wieder erlaubt - diesmal nimmt der Server ihn an.
		await retryAccepted(zwoelf);
	});

	/** Nach der Wartezeit noch einmal - und diesmal nimmt der Server ihn an. */
	async function retryAccepted(noon: number): Promise<void> {
		accountMock.sendUsagePing.mockResolvedValue("sent");
		vi.setSystemTime(noon + 6 * 60_000);
		await tickPing();
		expect(accountMock.sendUsagePing).toHaveBeenCalledTimes(2);
		expect(app.settings.usageLastDay).toBe("2026-08-24");
	}

	/** Ein erster Ping um 12:00, den der Server ablehnt. Gibt 12:00 zurueck. */
	async function declinedAtNoon(): Promise<number> {
		accountMock.sendUsagePing.mockResolvedValue("declined");
		await startPingAt("12:00");
		expect(accountMock.sendUsagePing).toHaveBeenCalledTimes(1);
		return wallStringToTs("2026-08-24", "12:00");
	}

	// Ein aelterer Server kennt den Endpunkt nicht und antwortet dauerhaft mit
	// 404. Ohne diesen Riegel klopfte jedes Geraet alle fuenf Minuten an - hinter
	// einer gemeinsamen Adresse bis die Bremse anschlaegt.
	it("fragt nicht weiter, wenn der Server die Meldung ablehnt", async () => {
		const zwoelf = await declinedAtNoon();

		// Auch nach der Wartezeit und in der naechsten Stunde kein zweiter Versuch.
		vi.setSystemTime(zwoelf + 10 * 60_000);
		await tickPing(3);
		vi.setSystemTime(wallStringToTs("2026-08-24", "15:00"));
		await tickPing(3);

		expect(accountMock.sendUsagePing).toHaveBeenCalledTimes(1);
		expect(app.settings.usageLastDay).toBe("");
	});

	// Die Absage gilt dem Server, nicht dem Programmlauf: wer sich danach mit
	// einem anderen verknuepft, soll dort wieder zaehlen duerfen.
	it("fragt nach einem Serverwechsel wieder", async () => {
		const zwoelf = await declinedAtNoon();

		accountMock.serverUrl = "https://anderer.example.de";
		await retryAccepted(zwoelf);
	});

	// Nicht jeder Fehlschlag heilt: ein falscher Schluessel bleibt falsch. Ohne
	// Deckel klopfte so ein Geraet alle fuenf Minuten weiter.
	it("hoert nach fuenf vergeblichen Versuchen in dieser Stunde auf", async () => {
		accountMock.sendUsagePing.mockResolvedValue("retry");
		const zwoelf = wallStringToTs("2026-08-24", "12:00");
		await startPingAt("12:00");

		// Sechs weitere Anlaeufe im Abstand der Wartezeit - nur vier duerfen durch.
		for (let i = 1; i < 7; i++) {
			vi.setSystemTime(zwoelf + i * 6 * 60_000);
			await tickPing();
		}

		expect(accountMock.sendUsagePing).toHaveBeenCalledTimes(5);
		expect(app.settings.usageLastDay).toBe("");
	});

	// Das Budget gilt je Stunde. Sonst brennt eine halbe Stunde ohne Netz um
	// 9 Uhr den ganzen Tag ab, obwohl das Geraet um 12 laengst wieder da ist.
	it("bekommt zur naechsten Stunde ein neues Budget", async () => {
		accountMock.sendUsagePing.mockResolvedValue("retry");
		const neun = wallStringToTs("2026-08-24", "09:00");
		await startPingAt("09:00");
		for (let i = 1; i < 7; i++) {
			vi.setSystemTime(neun + i * 6 * 60_000);
			await tickPing();
		}
		expect(accountMock.sendUsagePing).toHaveBeenCalledTimes(5);

		// Wieder online, naechste Stunde.
		accountMock.sendUsagePing.mockResolvedValue("sent");
		vi.setSystemTime(wallStringToTs("2026-08-24", "12:00"));
		await tickPing();

		expect(accountMock.sendUsagePing).toHaveBeenCalledTimes(6);
		expect(app.settings.usageLastDay).toBe("2026-08-24");
	});

	// Ohne verknuepftes Konto gibt es nichts zu melden - und nichts, was das
	// Budget verbrauchen duerfte. Wer sich um 10 Uhr verknuepft, zaehlt danach.
	it("verbraucht ohne verknuepftes Konto kein Budget", async () => {
		accountMock.serverUrl = "";
		const neun = wallStringToTs("2026-08-24", "09:00");
		await startPingAt("09:00");
		for (let i = 1; i < 7; i++) {
			vi.setSystemTime(neun + i * 6 * 60_000);
			await tickPing();
		}
		expect(accountMock.sendUsagePing).not.toHaveBeenCalled();

		// Jetzt verknuepft, dieselbe Stunde.
		accountMock.serverUrl = "https://tracker.example.de";
		vi.setSystemTime(neun + 8 * 6 * 60_000);
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
		expect(e.endTs).toBeNull(); // stop ist gemockt, der Eintrag bleibt unberuehrt
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
