// Hintergrund-Wächter: Leerlauf-Erkennung, Auto-Stop-Warnung, Pomodoro-Pause,
// Live-Tray-Tooltip. Läuft per 1-Sekunden-Intervall, solange die App offen ist.
import { invoke } from "@tauri-apps/api/core";
import { app } from "./app.svelte";
import { track } from "./analytics";
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
/**
 * Beginn des zuletzt gesehenen Laufs (für Flag-Reset bei Wechsel).
 *
 * Bewusst der Lauf-Beginn und nicht die Eintrags-id: an Mitternacht wird der Timer
 * geteilt, die id wechselt also mitten im Lauf. Am id-Wechsel hing der Reset –
 * damit verschwand der offene "Timer läuft noch"-Dialog um 00:00 von selbst und
 * die Warnung begann am neuen Tag wieder bei null.
 */
let lastRunStart: number | null = null;
/** Zuletzt gesetzter Tray-Tooltip (vermeidet IPC bei unveränderter Anzeige). */
let lastTooltip = "";

/** Eine Meldung zeigen, sofern erlaubt. Der lokale Name bleibt der bisherige. */
async function melden(title: string, body: string) {
	if (await ensureNotificationPermission()) await notify({ title, body });
}

/**
 * Feste Stunden, zu denen die Tagesmeldung „aktiv" versucht wird. Die erste
 * erreichte gewinnt, danach ist der Tag erledigt.
 *
 * Fest verdrahtet und nicht „beim Start": eine Meldung beim Start oder beim
 * Beenden waere ein Zeitstempel von Arbeitsbeginn bzw. Feierabend. So landet
 * jede Meldung auf einer von vier Uhrzeiten – aus einem beliebigen Zeitpunkt
 * werden vier Toepfe.
 *
 * Vier statt nur 12 Uhr, weil sonst jeder herausfaellt, dessen Rechner ueber
 * Mittag zu ist – und die Zahl waere dann eine Untergrenze statt eines Istwerts.
 * Der Preis ist bewusst in Kauf genommen: welcher Topf getroffen wird, sagt grob
 * etwas darueber, ab wann jemand die App offen hat.
 */
const PING_HOURS = [9, 12, 15, 17];

/** Laeuft gerade eine Tagesmeldung? Der Tick kommt jede Sekunde wieder. */
let pinging = false;

/**
 * Einmal je Kalendertag „aktiv" melden, sobald eine der PING_HOURS erreicht ist
 * und die App gerade laeuft.
 *
 * Haengt bewusst NICHT am Fehler-Schalter: das hier ist die Nutzerzahl, und die
 * waere bei jeder nennenswerten Ablehnquote nicht ungenau, sondern wertlos. Die
 * Meldung traegt keinen Inhalt – nur „an diesem Tag benutzt".
 *
 * Wessen Rechner zu keiner der vier Stunden laeuft, faellt aus der Zaehlung.
 * Nachzuholen hiesse, zu einer beliebigen und damit aussagekraeftigen Uhrzeit zu
 * senden – genau das soll nicht passieren.
 */
async function dailyPing(s: Settings): Promise<void> {
	if (pinging) return;
	const now = Date.now();
	if (!PING_HOURS.includes(zonedParts(now).hour)) return;
	const heute = fmtDate(now);
	if (s.usageLastDay === heute) return;
	pinging = true;
	try {
		await track("aktiv");
		await app.updateSettings({ usageLastDay: heute });
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
		void melden(
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
					void melden(
						"TimeTracker – Zeit für eine Pause",
						`${s.pomodoroMin} min fokussiert. ${s.pomodoroBreakMin} min Pause.`
					);
				} else if (s.pomodoroBreakMin > 0) {
					void melden("TimeTracker – Weiter geht's", "Pause vorbei – zurück zum Fokus.");
				} else {
					void melden(
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
