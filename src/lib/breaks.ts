// Automatischer Pausenabzug.
//
// Die Hausregel: ab 4 Stunden Tagesarbeitszeit 15 Minuten, ab 6 Stunden weitere
// 30 – zusammen also 45. Dieselbe Regel wendet LOGA auf die Anwesenheit an, und
// genau daher kam die dauerhafte Abweichung zwischen den hier erfassten Zeiten
// und dem Zeitwirtschaftsreport: ein Timer, der ueber die Mittagspause
// weiterlaeuft, zaehlt sie mit, LOGA zieht sie ab.
//
// Gerechnet wird auf der BRUTTO-Zeit eines Tages, also auf dem, was erfasst
// wurde. Auf der Nettozeit zu schwellen waere ein Zirkelschluss: 6,2 h brutto
// ergaeben 5,45 h netto, damit laege man wieder unter 6 h, und der Abzug haette
// sich selbst aufgehoben.
//
// Der Abzug beruehrt die gespeicherten Eintraege NICHT. Was der Timer erfasst
// hat, bleibt unveraendert in der Datei stehen – abgezogen wird erst beim
// Aufsummieren. Sonst waere die urspruengliche Zeit unwiederbringlich weg,
// sobald jemand den Schalter umlegt.

/**
 * Die Stufen der Regel, ABSTEIGEND nach Schwelle – breakDeduction nimmt die
 * erste passende. Eine dritte Stufe liesse sich hier einhaengen, ohne dass
 * grossForNet oder die Verteilung etwas davon mitbekommen muessten.
 */
export const BREAK_STEPS = [
	{ afterHours: 6, deduction: 0.75 },
	{ afterHours: 4, deduction: 0.25 }
] as const;

/**
 * Der Pausenabzug fuer eine Tages-Arbeitszeit, in Stunden.
 *
 * Absichtlich "mehr als", nicht "mindestens": ein exakt vierstuendiger Tag
 * braucht nach dem Arbeitszeitgesetz noch keine Pause.
 */
export function breakDeduction(workedHours: number): number {
	for (const step of BREAK_STEPS) {
		if (workedHours > step.afterHours) return step.deduction;
	}
	return 0;
}

/**
 * Den Pausenabzug eines Tages anteilig auf dessen Aktivitaeten verteilen.
 *
 * Anteilig statt "von der laengsten abziehen": nur so ist das Ergebnis
 * unabhaengig davon, in welcher Reihenfolge die Eintraege stehen, und keine
 * einzelne Aktivitaet traegt die Pause allein. Bei drei Stunden Projekt A und
 * einer Stunde Projekt B gehen von den 15 Minuten also gut 11 auf A und knapp
 * 4 auf B.
 *
 * @param perActivity Stunden je Aktivitaet EINES Tages (ohne Abwesenheiten)
 * @returns dieselbe Aufschluesselung, abzueglich der Pause
 */
export function deductBreakFromDay(perActivity: Map<string, number>): Map<string, number> {
	let total = 0;
	for (const h of perActivity.values()) total += h;

	const deduction = breakDeduction(total);
	// Die Pause ist immer kleiner als die Schwelle, ab der sie greift – der
	// Faktor kann also nie negativ werden. Die Wache steht fuer den Fall, dass
	// jemand die Schwellen spaeter verstellt.
	if (deduction <= 0 || total <= 0) return perActivity;
	if (deduction >= total) return new Map([...perActivity.keys()].map((id) => [id, 0]));

	const factor = (total - deduction) / total;
	const out = new Map<string, number>();
	for (const [id, h] of perActivity) out.set(id, h * factor);
	return out;
}

/** Tagesarbeitszeit abzueglich Pause. Fuer Summen ohne Aufschluesselung. */
export function deductBreakFromHours(workedHours: number): number {
	return Math.max(0, workedHours - breakDeduction(workedHours));
}

/**
 * Umkehrung: wie viel muss ERFASST sein, damit nach dem Abzug `netHours`
 * uebrig bleiben.
 *
 * Gebraucht beim Nachtragen aus dem Zeitwirtschaftsreport. Dessen Stunden sind
 * netto; wer sie eins zu eins einträgt, bekommt den Abzug ein zweites Mal und
 * bleibt dauerhaft zu niedrig. Gesucht ist also die Anwesenheit, nicht die
 * Arbeitszeit.
 *
 * Die Abzugsregel ist eine Treppe und damit nicht umkehrbar: 5,98 h und 6,48 h
 * ergeben beide 5,73 h netto. Genommen wird die KLEINSTE Anwesenheit, die
 * passt – die groessere entstuende nur durch eine Pause, die niemand gemacht hat.
 */
export function grossForNet(netHours: number): number {
	if (netHours <= 0) return 0;
	// Aufsteigend probieren: erst ohne Abzug, dann je Stufe. Genommen wird die
	// erste Stufe, die sich selbst bestaetigt.
	const candidates = [0, ...BREAK_STEPS.map((s) => s.deduction)].sort((a, b) => a - b);
	for (const deduction of candidates) {
		const gross = netHours + deduction;
		if (breakDeduction(gross) === deduction) return gross;
	}
	return netHours;
}
