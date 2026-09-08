// Der "Timer läuft noch"-Dialog: welches Ende vorgeschlagen wird und was als
// Eingabe durchgeht.
//
// Über Nacht ist "jetzt" NIE der Vorschlag - aufgehört wurde am Starttag.
import { grossForNet } from "./breaks";
import { fmtDate, startOfNextDay } from "./time";

const MIN = 60_000;

export interface SuggestOptions {
	/** Beginn des LAUFS – vor der Mitternachts-Teilung. */
	runStartTs: number;
	now: number;
	/**
	 * Frühester Projekt-Eintrag des Starttags, sonst null. Ist der Lauf der erste
	 * Eintrag des Tages, ist das sein eigener Start.
	 */
	dayStartTs: number | null;
	/** settings.hoursPerDay */
	hoursPerDay: number;
	/** settings.breakDeduction */
	deductBreaks: boolean;
}

/**
 * Das vorgeschlagene Ende für einen lange laufenden Timer.
 *
 * @returns Zeitstempel, minutengenau, innerhalb von (Laufbeginn, jetzt]
 */
export function suggestLongTimerEnd(opts: SuggestOptions): number {
	const { runStartTs, now, dayStartTs, hoursPerDay, deductBreaks } = opts;
	if (fmtDate(runStartTs) === fmtDate(now)) return now;

	// Soll-ANWESENHEIT, nicht Soll-Arbeitszeit: der Timer läuft über die Pause
	// mit, und mit aktivem Abzug zieht die App sie hinterher selbst ab.
	const gross = deductBreaks ? grossForNet(hoursPerDay) : hoursPerDay;
	const base = dayStartTs ?? runStartTs;
	const guess = Math.round((base + gross * 3600_000) / MIN) * MIN;

	// Nie vor den Laufbeginn und nie über den Starttag hinaus: was danach kommt,
	// ist die vergessene Nacht.
	const min = runStartTs + MIN;
	const max = Math.min(now, startOfNextDay(runStartTs) - MIN);
	return Math.max(min, Math.min(guess, max));
}

/** Warum eine eingegebene Endzeit nicht übernommen werden kann. */
export type EndError = "invalid" | "before-start" | "future";

/** Prüft die eingegebene Endzeit. */
export function checkEnd(ts: number, runStartTs: number, now: number): EndError | null {
	if (!Number.isFinite(ts)) return "invalid";
	if (ts <= runStartTs) return "before-start";
	if (ts > now) return "future";
	return null;
}
