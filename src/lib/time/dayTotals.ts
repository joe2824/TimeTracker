// Was ein Tag unterm Strich zählt.
//
// Lag zweimal ausgeschrieben in Svelte-Dateien - in der Monatsliste und in der
// Tagesbilanz - und damit ausserhalb jeder Testbarkeit.
import type { Entry } from "../types";
import { entryHours, isWorkday, openEntryUntil } from "./time";
import { breakDeduction } from "./breaks";

export interface DayTotals {
	/** Projektzeit, vor dem Pausenabzug. */
	worked: number;
	/** Urlaub, krank, frei - erfüllte Zeit. */
	absent: number;
	/** Abgefeierte Überstunden. */
	timeOff: number;
	/** Wie viel Pause von der Projektzeit abgeht. */
	pause: number;
	/** Projektzeit nach Pausenabzug. */
	net: number;
	/**
	 * Was der Tag zählt: Arbeitszeit + Abwesenheit, Zeitausgleich eingeschlossen.
	 *
	 * Er füllt das Tagessoll wie ein Urlaubstag. Getrennt geführt wird er nur
	 * für die Anzeige. Mit `workdays` gelten dieselben Regeln wie in
	 * `buildReport`, sonst zeigten Monatssumme und Bericht verschiedene Zahlen;
	 * nur das Runden je Aktivität macht der Bericht zusätzlich.
	 */
	total: number;
}

/**
 * Die Summen EINES Tages.
 *
 * @param entries die Einträge dieses Tages
 * @param opts.workdays Arbeitstage (0=So..6=Sa). Gesetzt, zählt eine Abwesenheit
 *   an einem freien Tag nicht, und neben einer Ganztags-Abwesenheit zählt keine
 *   Projektzeit – wie im Bericht.
 */
export function dayTotals(
	entries: Entry[],
	absenceIds: Set<string>,
	hoursPerDay: number,
	opts: { now?: number; deductBreaks?: boolean; workdays?: number[] } = {}
): DayTotals {
	const now = opts.now ?? Date.now();
	const workdays = opts.workdays;
	const counted = (e: Entry) => !workdays || isWorkday(e.startTs, workdays);
	const fullDayAbsence =
		!!workdays &&
		entries.some((e) => absenceIds.has(e.activityId) && counted(e) && (e.dayFraction ?? 1) >= 1);

	let worked = 0;
	let absent = 0;
	let timeOff = 0;

	for (const e of entries) {
		const isAbsence = absenceIds.has(e.activityId);
		if (isAbsence && !counted(e)) continue;
		if (!isAbsence && fullDayAbsence) continue;
		const hours = entryHours(e, isAbsence, hoursPerDay, openEntryUntil(e, now));
		if (isAbsence && e.timeOff === true) timeOff += hours;
		else if (isAbsence) absent += hours;
		else worked += hours;
	}

	// Die Pause hängt allein an der gearbeiteten Zeit - auf einen Urlaubstag oder
	// einen abgefeierten Tag gibt es keine.
	const pause = opts.deductBreaks ? breakDeduction(worked) : 0;
	const net = worked - pause;
	return { worked, absent, timeOff, pause, net, total: net + absent + timeOff };
}
