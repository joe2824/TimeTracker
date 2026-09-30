// Anzeigetexte für Abwesenheiten – an einer Stelle, damit Tagesliste, Abgleich
// und Zeiterfassung dieselben Worte benutzen.

/** Wie ein Zeitausgleich in Listen heisst – statt des Namens der Abwesenheits-Aktivität. */
export const TIME_OFF_LABEL = "Zeitausgleich";

/** "½ Tag" oder "ganzer Tag" für einen Tagesanteil (fehlend = ganzer Tag). */
export function dayFractionLabel(fraction: number | undefined): string {
	return (fraction ?? 1) === 0.5 ? "½ Tag" : "ganzer Tag";
}

/** Name einer Abwesenheit in Listen: Zeitausgleich oder der Name der Aktivität. */
export function absenceLabel(isTimeOff: boolean, activityName: string): string {
	return isTimeOff ? TIME_OFF_LABEL : activityName;
}
