// Was ein Tag unterm Strich zählt.
//
// Lag zweimal ausgeschrieben in Svelte-Dateien - in der Monatsliste und in der
// Tagesbilanz - und damit ausserhalb jeder Testbarkeit.
import type { Entry } from "../types";
import { entryHours } from "./time";
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
	 * für die Anzeige - dieselbe Rechnung wie in `buildReport`, sonst zeigten
	 * die Monatssumme und der Bericht verschiedene Zahlen.
	 */
	total: number;
}

export function dayTotals(
	entries: Entry[],
	absenceIds: Set<string>,
	hoursPerDay: number,
	opts: { now?: number; deductBreaks?: boolean } = {}
): DayTotals {
	const now = opts.now ?? Date.now();
	let worked = 0;
	let absent = 0;
	let timeOff = 0;

	for (const e of entries) {
		const isAbsence = absenceIds.has(e.activityId);
		const hours = entryHours(e, isAbsence, hoursPerDay, now);
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
