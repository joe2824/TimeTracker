// Hintergrund-Wächter: Leerlauf-Erkennung, Auto-Stop-Warnung, Pomodoro-Pause,
// Live-Tray-Tooltip. Läuft per 1-Sekunden-Intervall, solange die App offen ist.
import { invoke } from "@tauri-apps/api/core";
import { app } from "./app.svelte";
import { account } from "./sync/account.svelte";
import type { Settings } from "./types";
import { fmtDate, fmtHMS } from "./time";
import { zonedParts } from "./tz";
import { ensureNotificationPermission } from "./reminders";
import { notify } from "./platform/notify";

/** Reaktiver Zustand für den Leerlauf-Dialog. */
class WatcherState {
	/** Gesetzt, wenn ein Leerlauf erkannt wurde und der Nutzer entscheiden soll. */
	idlePrompt = $state<{ idleStart: number; idleSeconds: number } | null>(null);
	/** Gesetzt, wenn ein Timer sehr lange (z.B. über Nacht) läuft und der Nutzer die
	 *  tatsächliche Endzeit direkt eingeben soll. */
	longTimerPrompt = $state<{ activityId: string; startTs: number; elapsedSec: number } | null>(
		null
	);
	/** Dev-Override: Berichts-Erinnerung erzwingen (nur zum Debuggen). */
	forceReportReminder = $state(false);
	/** Der Berichts-Erinnerungs-Dialog wurde in diesem App-Lauf weggeklickt. */
	reportReminderDismissed = $state(false);
}
export const watchers = new WatcherState();

let interval: ReturnType<typeof setInterval> | null = null;
let autoStopNotified = false;
/** Schlüssel der zuletzt benachrichtigten Pomodoro-Phase ("idx:f"|"idx:b"). */
let lastPomoKey: string | null = null;
/** Signatur der Pomodoro-Dauern; ändert sich -> Phasen-Key zurücksetzen. */
let lastPomoSig = "";
/** Prompt bereits gezeigt; bleibt true bis der Nutzer wieder aktiv ist (idle < Schwelle). */
let idlePromptShown = false;
/** Beginn des zuletzt gesehenen Laufs (für Flag-Reset bei Wechsel). */
let lastRunStart: number | null = null;
/** Zuletzt gesetzter Tray-Tooltip (vermeidet IPC bei unveränderter Anzeige). */
let lastTooltip = "";

/** Eine Meldung zeigen, sofern erlaubt. Der lokale Name bleibt der bisherige. */
async function reportIt(title: string, body: string) {
	if (await ensureNotificationPermission()) await notify({ title, body });
}

/**
 * Wie oft nachgesehen wird, ob die Tagesmeldung noch aussteht. Der erste
 * Versuch laeuft sofort beim Start; dieser Takt holt nur nach, was daran
 * gescheitert ist, dass Netz oder Konto noch nicht standen.
 */
const PING_CHECK_MS = 60 * 1000;

/**
 * Abstand zwischen zwei Versuchen am selben Tag. Ohne diese Sperre klopfte ein
 * Geraet, dessen Meldung abgewiesen wurde, eine volle Stunde lang im Takt der
 * Pruefung gegen den Server.
 */
const PING_RETRY_MS = 5 * 60 * 1000;

/** Der Zeitgeber der Tagesmeldung - eigener Lauf, siehe startUsagePing(). */
let pingInterval: ReturnType<typeof setInterval> | null = null;

/** Laeuft gerade eine Tagesmeldung? Der Tick kommt jede Sekunde wieder. */
let pinging = false;
/** Wann zuletzt versucht - unabhaengig davon, ob es geklappt hat. */
let lastPingAttempt = 0;
/**
 * Wie oft in dieser Stunde vergeblich versucht wurde - und in welcher.
 *
 * Nicht jeder Fehlschlag heilt: ein falscher Schluessel bleibt falsch. Ohne
 * Deckel klopfte ein solches Geraet den ganzen Tag weiter und braechte hinter
 * einer gemeinsamen Adresse die Bremse zum Anschlagen.
 *
 * Je Stunde und nicht je Tag: wer um 9 Uhr ohne Netz war, hat das Budget sonst
 * in zwanzig Minuten verbraucht und faellt aus der Zaehlung, obwohl er um 12
 * laengst wieder online ist.
 */
let failedPingSlot = "";
let failedPingCount = 0;
/** So viele vergebliche Versuche je Stunde, dann Ruhe bis zur naechsten. */
const MAX_PING_FAILURES = 5;
/**
 * Der Server, der die Meldung abgelehnt hat - dort nicht mehr fragen. Ein
 * aelterer Server kennt den Endpunkt nicht und antwortet dauerhaft mit 404;
 * ein Buero hinter einer gemeinsamen Adresse braechte damit nur die Bremse zum
 * Anschlagen.
 *
 * Die Adresse und nicht bloss ein Ja/Nein: wer sich danach mit einem anderen
 * Server verknuepft, soll dort wieder zaehlen duerfen.
 */
let declinedServer: string | null = null;

/**
 * Einmal je Kalendertag „aktiv" melden, sobald die App laeuft. Ohne feste
 * Uhrzeit: wer nur zwischen zwei Terminen kurz aufmacht, faellt sonst aus der
 * Zaehlung.
 */
async function dailyPing(s: Settings): Promise<void> {
	if (pinging) return;
	// Ohne Ziel gibt es nichts zu melden - und nichts, was als Fehlversuch gelten
	// duerfte. Das Ziel ist der verknuepfte Server, sonst der aus dem Build.
	const server = account.usagePingServer;
	if (!server || server === declinedServer) return;
	const now = Date.now();
	const today = fmtDate(now);
	if (s.usageLastDay === today) return;
	const slot = `${today}:${zonedParts(now).hour}`;
	if (failedPingSlot !== slot) {
		failedPingSlot = slot;
		failedPingCount = 0;
	}
	if (failedPingCount >= MAX_PING_FAILURES) return;
	if (now - lastPingAttempt < PING_RETRY_MS) return;
	pinging = true;
	lastPingAttempt = now;
	try {
		const result = await account.sendUsagePing();
		// Erst vermerken, wenn der Server die Meldung wirklich angenommen hat.
		// Sonst fiele ein Geraet, das gerade offline oder ausgebremst war, fuer
		// diesen Tag ersatzlos aus der Zaehlung.
		if (result === "sent") await app.updateSettings({ usageLastDay: today });
		else if (result === "declined") declinedServer = server;
		else failedPingCount++;
	} finally {
		pinging = false;
	}
}

function resetFlags() {
	autoStopNotified = false;
	lastPomoKey = null;
	idlePromptShown = false;
	watchers.longTimerPrompt = null;
}

async function tick() {
	const s = app.settings;
	const running = app.running;

	// --- Live-Tray-Tooltip (nur bei Änderung senden) ---
	const tooltip = running
		? `${app.activityName(running.activityId)} – ${fmtHMS(app.runningSeconds)}`
		: "TimeTracker";
	if (tooltip !== lastTooltip) {
		lastTooltip = tooltip;
		void invoke("set_tray_tooltip", { text: tooltip }).catch(() => {});
	}

	if (!running) {
		resetFlags();
		lastRunStart = null;
		return;
	}

	// Aktivitätswechsel = neuer Lauf -> Erinnerungen wieder scharf stellen.
	const runStart = app.runStartTs;
	if (runStart !== lastRunStart) {
		lastRunStart = runStart;
		resetFlags();
	}

	// Der ganze Lauf, nicht nur das Stück seit Mitternacht: sonst meldete sich die
	// Warnung bei einem vergessenen Timer jeden Tag aufs Neue mit "läuft seit 10 h".
	const elapsedSec = app.runSeconds;

	// --- Auto-Stop-Warnung (Timer vergessen) ---
	if (s.maxTimerHours > 0 && elapsedSec >= s.maxTimerHours * 3600 && !autoStopNotified) {
		autoStopNotified = true;
		// In-App-Dialog mit Endzeit-Eingabe (falls App offen) …
		watchers.longTimerPrompt = {
			activityId: running.activityId,
			startTs: runStart ?? running.startTs,
			elapsedSec
		};
		// … und OS-Benachrichtigung (falls App nur im Tray läuft).
		void reportIt(
			"TimeTracker – Timer läuft sehr lange",
			`„${app.activityName(running.activityId)}" läuft seit über ${s.maxTimerHours} h. Noch aktiv?`
		);
	}

	// --- Pomodoro: Fokus->Pause->Fokus-Zyklus (optionales Feature) ---
	// Geänderte Dauer-Einstellungen verschieben den Zyklus -> Key zurücksetzen,
	// damit kein versehentlicher Hinweis durch den Sprung ausgelöst wird.
	const pomoSig = `${s.pomodoroMin}:${s.pomodoroBreakMin}`;
	if (pomoSig !== lastPomoSig) {
		lastPomoSig = pomoSig;
		lastPomoKey = null;
	}
	const pomo = app.pomodoro;
	if (pomo) {
		const key = `${pomo.cycleIndex}:${pomo.phase}`;
		if (key !== lastPomoKey) {
			// Erste Beobachtung nur merken (kein Hinweis beim Start des Timers).
			if (lastPomoKey !== null) {
				if (pomo.phase === "break") {
					void reportIt(
						"TimeTracker – Zeit für eine Pause",
						`${s.pomodoroMin} min fokussiert. ${s.pomodoroBreakMin} min Pause.`
					);
				} else if (s.pomodoroBreakMin > 0) {
					void reportIt("TimeTracker – Weiter geht's", "Pause vorbei – zurück zum Fokus.");
				} else {
					void reportIt(
						"TimeTracker – Zeit für eine Pause",
						`${s.pomodoroMin} min fokussiert gearbeitet.`
					);
				}
			}
			lastPomoKey = key;
		}
	} else {
		lastPomoKey = null;
	}

	// --- Leerlauf-Erkennung ---
	// Erst wieder fragen, wenn der Nutzer zwischendurch aktiv war (idle < Schwelle).
	if (s.idleThresholdMin > 0 && !watchers.idlePrompt) {
		const idle = await invoke<number>("idle_seconds").catch(() => 0);
		const threshold = s.idleThresholdMin * 60;
		if (idle < threshold) {
			idlePromptShown = false;
		} else if (!idlePromptShown) {
			idlePromptShown = true;
			watchers.idlePrompt = { idleStart: Date.now() - idle * 1000, idleSeconds: idle };
		}
	}
}

/**
 * Die Waechter, die es nur in der Desktop-Huelle gibt: Leerlauf, Auto-Stop,
 * Pomodoro, Tray-Tooltip.
 */
export function startWatchers(): void {
	if (interval) return;
	interval = setInterval(() => void tick(), 1000);
}

export function stopWatchers(): void {
	if (interval) clearInterval(interval);
	interval = null;
}

/**
 * Die Tagesmeldung. Eigener Lauf, weil sie als einzige auch im Browser gilt -
 * startWatchers() steht hinter der Desktop-Weiche, und dort kam sie nie an.
 */
export function startUsagePing(): void {
	if (pingInterval) return;
	// Ein frischer Lauf darf sofort melden - beide Sperren gelten innerhalb eines Laufs.
	lastPingAttempt = 0;
	declinedServer = null;
	failedPingCount = 0;
	pingInterval = setInterval(() => void dailyPing(app.settings), PING_CHECK_MS);
	// Sofort und nicht erst nach der ersten Minute: ein kurzer Blick in die App
	// waere sonst keine Nutzung.
	void dailyPing(app.settings);
}

export function stopUsagePing(): void {
	if (pingInterval) clearInterval(pingInterval);
	pingInterval = null;
}

/** Nutzer hat den Leerlauf-Dialog entschieden. */
export async function resolveIdle(action: "keep" | "subtract" | "discard"): Promise<void> {
	const p = watchers.idlePrompt;
	watchers.idlePrompt = null;
	if (!p || !app.running) return;
	// "keep": idlePromptShown bleibt true -> kein sofortiges Wieder-Aufpoppen,
	// erst wenn der Nutzer wieder aktiv war (tick erkennt idle < Schwelle).
	if (action === "subtract") {
		await app.stop(p.idleStart);
	} else if (action === "discard") {
		await app.deleteEntry(app.running);
	}
}

/**
 * Nutzer hat den "Timer läuft lange"-Dialog entschieden.
 * "keep": weiterlaufen lassen. "stop": bei `endTs` beenden (auf [Start, jetzt] begrenzt).
 */
export async function resolveLongTimer(action: "keep" | "stop", endTs?: number): Promise<void> {
	const p = watchers.longTimerPrompt;
	watchers.longTimerPrompt = null;
	if (action !== "stop" || !p || !app.running) return;
	const ts = Math.min(Math.max(endTs ?? Date.now(), p.startTs), Date.now());
	await app.stop(ts);
}

// ---------- Dev-Trigger (zum Debuggen der Dialoge) ----------
export function devTriggerIdle(): void {
	watchers.idlePrompt = { idleStart: Date.now() - 15 * 60 * 1000, idleSeconds: 900 };
}
export function devTriggerLongTimer(): void {
	watchers.longTimerPrompt = {
		activityId: app.running?.activityId ?? app.visibleActivities[0]?.id ?? "",
		startTs: Date.now() - 11 * 3600 * 1000,
		elapsedSec: 11 * 3600
	};
}
export function devTriggerReportReminder(): void {
	watchers.forceReportReminder = true;
}
