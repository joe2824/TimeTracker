// Zuordnung von Outlook-Terminen auf Aktivitaeten – reine Logik, damit die Regel
// testbar ist und nicht in der Import-Ansicht versteckt liegt.
import type { CalendarEvent } from "./outlook";
import type { Activity } from "./types";

/**
 * Darf dieser Termin ueberhaupt eine Abwesenheit werden?
 *
 * Eine Abwesenheit ist ein ganzer oder halber TAG, nie eine Zeitspanne – also
 * kann nur ein Ganztags-Termin eine sein. Ein zweistuendiger Termin mit Status
 * "abwesend" (Arzt o.ae.) ist kein Urlaubstag; dort traegt man einfach keine
 * Projektzeit ein.
 */
export function absenceAllowed(ev: Pick<CalendarEvent, "allDay">): boolean {
	return ev.allDay;
}

/** Auswahl je Termin – bei Uhrzeit ohne die Abwesenheits-Aktivitaet. */
export function activityOptions(
	ev: Pick<CalendarEvent, "allDay">,
	activities: Activity[]
): Activity[] {
	return absenceAllowed(ev) ? activities : activities.filter((a) => !a.isAbsence);
}

/**
 * Vorauswahl fuer einen Termin: "" = ignorieren.
 *
 * Reihenfolge: Ganztags -> Abwesenheiten; sonst gemerktes Stichwort; sonst
 * Namenstreffer. Bei Terminen mit Uhrzeit kann nie eine Abwesenheit herauskommen –
 * auch dann nicht, wenn die Stichwort-Zuordnung aus einer frueheren Version noch
 * "Zahnarzt -> Abwesenheiten" kennt.
 */
export function guessActivity(
	ev: Pick<CalendarEvent, "subject" | "allDay">,
	activities: Activity[],
	keywordMap: Record<string, string>
): string {
	if (absenceAllowed(ev)) return activities.find((a) => a.isAbsence)?.id ?? "";

	const usable = activityOptions(ev, activities);
	const subj = ev.subject.toLowerCase();
	for (const [kw, id] of Object.entries(keywordMap)) {
		if (kw && subj.includes(kw) && usable.some((a) => a.id === id)) return id;
	}
	return usable.find((a) => subj.includes(a.name.toLowerCase()))?.id ?? "";
}
