// Hintergrund-Wächter: Leerlauf-Erkennung, Auto-Stop-Warnung, Pomodoro-Pause,
// Live-Tray-Tooltip. Läuft per 1-Sekunden-Intervall, solange die App offen ist.
import { invoke } from "@tauri-apps/api/core";
import { app } from "./app.svelte";
import { sendDailyTelemetryPing } from "./analytics";
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
 * Feste Stunden, zu denen die Tagesmeldung „aktiv" versucht wird. Die erste
 * erreichte gewinnt, danach ist der Tag erledigt.
 */
const PING_HOURS = [9, 12, 15, 17];

/**
 * Abstand zwischen zwei Versuchen am selben Tag.
 *
 * Der Tick kommt jede Sekunde: ohne diese Sperre haemmerte ein Geraet, dessen
 * Ping abgewiesen wurde, eine volle Stunde lang sekuendlich gegen den Server.
 */
const PING_RETRY_MS = 5 * 60 * 1000;

/** Laeuft gerade eine Tagesmeldung? Der Tick kommt jede Sekunde wieder. */
let pinging = false;
/** Wann zuletzt versucht - unabhaengig davon, ob es geklappt hat. */
let lastPingAttempt = 0;
/**
 * Dieser Server nimmt keine Meldung an. Fuer den Rest des Laufs nicht mehr
 * fragen: ein Server ohne TELEMETRY_KEY antwortet dauerhaft mit 404, und ein
 * Buero hinter einer gemeinsamen Adresse braechte damit nur die Bremse zum
 * Anschlagen.
 */
let pingDeclined = false;

/**
 * Einmal je Kalendertag „aktiv" melden, sobald eine der PING_HOURS erreicht ist
 * und die App gerade laeuft.
 */
async function dailyPing(s: Settings): Promise<void> {
	if (pinging || pingDeclined) return;
	const now = Date.now();
	if (!PING_HOURS.includes(zonedParts(now).hour)) return;
	const today = fmtDate(now);
	if (s.usageLastDay === today) return;
	if (now - lastPingAttempt < PING_RETRY_MS) return;
	pinging = true;
	lastPingAttempt = now;
	try {
		const result = await sendDailyTelemetryPing(account.serverUrl);
		// Erst vermerken, wenn der Server die Meldung wirklich angenommen hat.
		// Sonst fiele ein Geraet, das gerade offline oder ausgebremst war, fuer
		// diesen Tag ersatzlos aus der Zaehlung.
		if (result === "sent") await app.updateSettings({ usageLastDay: today });
		else if (result === "declined") pingDeclined = true;
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

	void dailyPing(s);

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

export function startWatchers(): void {
	if (interval) return;
	// Ein frischer Lauf darf sofort melden - beide Sperren gelten innerhalb eines Laufs.
	lastPingAttempt = 0;
	pingDeclined = false;
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
