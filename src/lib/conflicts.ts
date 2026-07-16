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

/**
 * Ueberschneidet sich die Zeitspanne mit einer bestehenden Projektzeit?
 * Man kann nicht gleichzeitig an zwei Dingen arbeiten.
 *
 * Abwesenheiten bleiben aussen vor – die sind tagesgenau (start == end == Tagesmitte)
 * und haben keine Spanne, die sich ueberschneiden koennte.
 *
 * Intervalle sind halboffen: 08:00–12:00 und 12:00–14:00 stossen an, ueberschneiden
 * sich also nicht. Ein laufender Eintrag (endTs === null) zaehlt bis `now`.
 *
 * @returns der erste ueberschneidende Eintrag, sonst null
 */
export function overlapConflict(
	entries: Entry[],
	candidate: { activityId: string; startTs: number; endTs: number | null },
	absenceIds: Set<string>,
	opts: { excludeId?: string; now?: number } = {}
): Entry | null {
	// Ein laufender Timer hat noch kein Ende – erst beim Stoppen steht die Spanne fest.
	if (candidate.endTs == null) return null;
	if (absenceIds.has(candidate.activityId)) return null;

	const now = opts.now ?? Date.now();
	const aStart = candidate.startTs;
	const aEnd = candidate.endTs;

	for (const e of entries) {
		if (e.id === opts.excludeId) continue;
		if (absenceIds.has(e.activityId)) continue;
		const bEnd = e.endTs ?? now;
		if (aStart < bEnd && e.startTs < aEnd) return e;
	}
	return null;
}
