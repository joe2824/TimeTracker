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
}
export const watchers = new WatcherState();

let interval: ReturnType<typeof setInterval> | null = null;
let autoStopNotified = false;
let pomodoroNotified = false;
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
	pomodoroNotified = false;
	idlePromptShown = false;
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
		void notify(
			"TimeTracker – Timer läuft sehr lange",
			`„${app.activityName(running.activityId)}" läuft seit über ${s.maxTimerHours} h. Noch aktiv?`
		);
	}

	// --- Pomodoro/Pausen-Erinnerung ---
	if (s.pomodoroEnabled && s.pomodoroMin > 0 && elapsedSec >= s.pomodoroMin * 60 && !pomodoroNotified) {
		pomodoroNotified = true;
		void notify("TimeTracker – Zeit für eine Pause", `${s.pomodoroMin} min fokussiert gearbeitet. 🧘`);
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
