import { clockToMin } from "./time";

/** Presets für die Startzeit-Auswahl (Minuten in der Vergangenheit; 0 = jetzt). */
export const START_PRESETS = [15, 30, 60] as const;

/**
 * Effektiver Start-Zeitstempel aus Preset (Minuten zurück) und optionaler Uhrzeit.
 * Eine gesetzte Uhrzeit (`customStart`, HH:MM) überschreibt das Preset.
 * Rückgabe `null` bei ungültiger oder in der Zukunft liegender Uhrzeit.
 */
export function resolveStartTs(
	presetMin: number,
	customStart: string,
	now: number = Date.now()
): number | null {
	if (customStart) {
		const min = clockToMin(customStart);
		if (min == null) return null;
		const d = new Date(now);
		d.setHours(Math.floor(min / 60), min % 60, 0, 0);
		const ts = d.getTime();
		return ts > now ? null : ts; // in der Zukunft -> ungültig
	}
	return now - presetMin * 60_000;
}

/**
 * Wandelt einen aufgelösten Start-Zeitstempel in das Argument für `startActivity` um:
 * „praktisch jetzt" (< 1 s Abweichung) -> `undefined` (kein Rückdatieren).
 */
export function toStartArg(ts: number, now: number = Date.now()): number | undefined {
	return now - ts < 1000 ? undefined : ts;
}
