// Startzeit-Auswahl vor einem Timer-Start: Preset "vor X min" (0 = jetzt) oder
// freie Uhrzeit, die das Preset überschreibt. Gemeinsam für Hauptfenster
// (TrackingPanel) und Tray-Flyout; jedes Fenster hat seinen eigenen JS-Kontext
// und damit seine eigene Instanz.
import { app } from "../app.svelte";
import { fmtClock, fmtDateHuman, midnightSplitHint } from "../time/time";
import { resolveStartTs, toStartArg } from "../time/startTime";
import { toast } from "svelte-sonner";

export class StartPicker {
	presetMin = $state(0);
	customStart = $state("");

	/** Gilt gerade die freie Uhrzeit? Steuert Hervorhebung UND Auswertung. */
	get usingClock(): boolean {
		return this.customStart !== "";
	}

	/** Hinweistext zur gewählten Startzeit (tickt mit app.now); null bei "jetzt". */
	get hint(): string | null {
		if (!this.customStart && this.presetMin === 0) return null;
		const now = app.now;
		const ts = resolveStartTs(this.presetMin, this.customStart, now);
		if (ts == null) return "unlesbare Uhrzeit";
		const shared = midnightSplitHint(ts, now);
		if (shared) return `beginnt ${fmtDateHuman(ts)} um ${fmtClock(ts)} – ${shared}`;
		return `Timer beginnt um ${fmtClock(ts)}`;
	}

	/** Preset wählen (0 = jetzt); verwirft eine freie Uhrzeit. */
	choosePreset(min: number): void {
		this.presetMin = min;
		this.customStart = "";
	}

	/** Auf freie Uhrzeit umschalten - mit der aktuellen vorbelegt, damit das Feld nie leer aktiv ist. */
	chooseClock(): void {
		if (!this.customStart) this.customStart = fmtClock(Date.now());
		this.presetMin = 0;
	}

	/** Zurück auf "jetzt", damit ein Offset nicht am nächsten Start klebt. */
	reset(): void {
		this.choosePreset(0);
	}

	/**
	 * Den Timer zur gewählten Zeit starten. Öffnet das die Rückfrage zum
	 * Rückdatieren, bleibt die Auswahl stehen: nach Abbrechen soll sie noch da
	 * sein, nach Bestätigen setzt der Aufrufer per reset() zurück.
	 *
	 * @returns false bei unlesbarer Uhrzeit oder offener Rückfrage - dann ist noch nichts passiert
	 */
	async start(activityId: string): Promise<boolean> {
		const now = Date.now();
		const ts = resolveStartTs(this.presetMin, this.customStart, now);
		if (ts == null) {
			toast.error("Unlesbare Startzeit.");
			return false;
		}
		await app.startActivity(activityId, toStartArg(ts, now));
		if (app.backdatePrompt) return false;
		this.reset();
		return true;
	}
}

export const startPicker = new StartPicker();
