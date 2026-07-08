// Hintergrund-Wächter: Leerlauf-Erkennung, Auto-Stop-Warnung, Pomodoro-Pause,
// Live-Tray-Tooltip. Läuft per 1-Sekunden-Intervall, solange die App offen ist.
import { invoke } from "@tauri-apps/api/core";
import { app } from "./app.svelte";
import { fmtHMS } from "./time";
import { ensureNotificationPermission } from "./reminders";
import { sendNotification } from "@tauri-apps/plugin-notification";

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
/** Eintrags-id des zuletzt gesehenen laufenden Timers (für Flag-Reset bei Wechsel). */
let lastRunningId: string | null = null;
/** Zuletzt gesetzter Tray-Tooltip (vermeidet IPC bei unveränderter Anzeige). */
let lastTooltip = "";

async function notify(title: string, body: string) {
	if (await ensureNotificationPermission()) sendNotification({ title, body });
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
		lastRunningId = null;
		return;
	}

	// Aktivitätswechsel = neuer Eintrag -> Erinnerungen wieder scharf stellen.
	if (running.id !== lastRunningId) {
		lastRunningId = running.id;
		resetFlags();
	}

	const elapsedSec = app.runningSeconds;

	// --- Auto-Stop-Warnung (Timer vergessen) ---
	if (s.maxTimerHours > 0 && elapsedSec >= s.maxTimerHours * 3600 && !autoStopNotified) {
		autoStopNotified = true;
		// In-App-Dialog mit Endzeit-Eingabe (falls App offen) …
		watchers.longTimerPrompt = {
			activityId: running.activityId,
			startTs: running.startTs,
			elapsedSec
		};
		// … und OS-Benachrichtigung (falls App nur im Tray läuft).
		void notify(
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
					void notify(
						"TimeTracker – Zeit für eine Pause",
						`${s.pomodoroMin} min fokussiert. ${s.pomodoroBreakMin} min Pause.`
					);
				} else if (s.pomodoroBreakMin > 0) {
					void notify("TimeTracker – Weiter geht's", "Pause vorbei – zurück zum Fokus.");
				} else {
					void notify(
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

export function startWatchers(): void {
	if (interval) return;
	interval = setInterval(() => void tick(), 1000);
}

export function stopWatchers(): void {
	if (interval) clearInterval(interval);
	interval = null;
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
