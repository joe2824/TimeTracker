import { clockToMin } from "./time";

/** Presets für die Startzeit-Auswahl (Minuten in der Vergangenheit; 0 = jetzt). */
export const START_PRESETS = [15, 30, 60] as const;

/**
 * Effektiver Start-Zeitstempel aus Preset (Minuten zurück) und optionaler Uhrzeit.
 * Eine gesetzte Uhrzeit (`customStart`, HH:MM) überschreibt das Preset.
 *
 * Die Uhrzeit meint immer ihr LETZTES Auftreten bis jetzt: wer um 01:10 „23:00"
 * eingibt, meint die vergangene Nacht, nicht heute Abend. Vorher galt das als
 * ungültig, obwohl die Absicht eindeutig ist.
 *
 * Rückgabe `null` nur bei unlesbarer Uhrzeit.
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
		// Uhrzeit heute noch nicht erreicht -> gemeint ist gestern. setDate statt
		// -24 h: an DST-Tagen hat ein Tag 23 oder 25 Stunden.
		if (d.getTime() > now) d.setDate(d.getDate() - 1);
		return d.getTime();
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
