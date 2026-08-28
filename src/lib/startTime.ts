import { clockToMin, fmtDate, minToClock, stepDate, toTs } from "./time";

/** Presets für die Startzeit-Auswahl (Minuten in der Vergangenheit; 0 = jetzt). */
export const START_PRESETS = [15, 30, 60] as const;

/**
 * Effektiver Start-Zeitstempel aus Preset (Minuten zurück) und optionaler Uhrzeit.
 * Eine gesetzte Uhrzeit (`customStart`, HH:MM) überschreibt das Preset.
 */
export function resolveStartTs(
	presetMin: number,
	customStart: string,
	now: number = Date.now()
): number | null {
	if (customStart) {
		const min = clockToMin(customStart);
		if (min == null) return null;
		// In der Zeitzone des Kontos, nicht der des Geraets: der Startzeitpunkt
		// wird zu einem Eintrag, und dessen Tag muss auf jedem Geraet derselbe sein.
		const today = fmtDate(now);
		let ts = toTs(today, minToClock(min));
		// Uhrzeit heute noch nicht erreicht -> gemeint ist gestern. Ueber den
		// Kalender statt -24 h: an einem Umstellungstag hat ein Tag 23 oder 25 Stunden.
		if (ts > now) ts = toTs(stepDate(today, -1), minToClock(min));
		return ts;
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
