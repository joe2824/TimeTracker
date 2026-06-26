import type { Entry } from "./types";
import { fmtDate } from "./time";

export type DayConflict = "full-day-absence" | "project-time" | null;

/**
 * Tagesregel: Eine Ganztags-Abwesenheit und Projektzeit schließen sich am selben
 * (lokalen) Tag aus; ein halber Urlaubstag darf neben Projektzeit liegen.
 *
 * Reine Funktion – keine Seiteneffekte, damit testbar.
 *
 * @returns "full-day-absence" wenn ein Projekteintrag an einem Ganztags-Abwesenheitstag liegt,
 *          "project-time" wenn eine Ganztags-Abwesenheit an einem Tag mit Projektzeit liegt,
 *          sonst null.
 */
export function dayConflict(
	entries: Entry[],
	candidate: { activityId: string; startTs: number; dayFraction?: number },
	absenceId: string | undefined,
	opts: { excludeId?: string } = {}
): DayConflict {
	const key = fmtDate(candidate.startTs);
	const isAbs = candidate.activityId === absenceId;
	const fullDayAbs = isAbs && (candidate.dayFraction ?? 1) >= 1;

	const sameDay = entries.filter(
		(e) => e.id !== opts.excludeId && fmtDate(e.startTs) === key
	);

	if (
		!isAbs &&
		sameDay.some((e) => e.activityId === absenceId && (e.dayFraction ?? 1) >= 1)
	) {
		return "full-day-absence";
	}
	if (fullDayAbs && sameDay.some((e) => e.activityId !== absenceId)) {
		return "project-time";
	}
	return null;
}
