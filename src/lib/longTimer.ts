// Der "Timer läuft noch"-Dialog: welches Ende vorgeschlagen wird und was als
// Eingabe durchgeht.
//
// Reine Logik, damit der heikle Teil testbar bleibt: der Vorschlag entscheidet,
// was ein Nutzer wegklickt, ohne hinzusehen.
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
 * Läuft er noch am selben Tag, ist "jetzt" richtig: der Nutzer sitzt davor und
 * hört gerade auf.
 *
 * Über Nacht ist "jetzt" dagegen NIE die Antwort. Der Timer lief weiter, weil
 * niemand da war – aufgehört wurde am STARTTAG, und der Dialog erscheint erst
 * am Morgen danach. Ein auf "jetzt" vorbelegtes Feld schreibt dann die ganze
 * Nacht plus den halben Vormittag auf das Projekt, und zwar genau dann, wenn
 * jemand nur schnell bestätigt.
 *
 * Geschätzt wird über den Arbeitstag: Tagesbeginn + Soll-Anwesenheit. Das ist
 * die einzige Zahl, die wir über den Feierabend haben, und sie liegt immer am
 * richtigen TAG – die Minuten korrigiert der Nutzer, den Tag hätte er
 * übersehen.
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

/**
 * Prüft die eingegebene Endzeit.
 *
 * Bewusst als Fehler und nicht als stille Korrektur: `resolveLongTimer` klemmt
 * einen Wert außerhalb der Spanne auf "jetzt" fest. Wer im datetime-local-Feld
 * nur die UHRZEIT tippt und das Datum stehen lässt, landet damit auf HEUTE
 * 18:26 – in der Zukunft – und bekommt kommentarlos 08:36 gebucht. Der Dialog
 * sagt "Ende 18:26", die Datei sagt etwas anderes.
 */
export function checkEnd(ts: number, runStartTs: number, now: number): EndError | null {
	if (!Number.isFinite(ts)) return "invalid";
	if (ts <= runStartTs) return "before-start";
	if (ts > now) return "future";
	return null;
}
