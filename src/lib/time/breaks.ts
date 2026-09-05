// Automatischer Pausenabzug. Beruehrt die gespeicherten Eintraege NICHT - abgezogen
// wird erst beim Aufsummieren.

/**
 * Die Stufen der Regel, ABSTEIGEND nach Schwelle – breakDeduction nimmt die
 * erste passende. Eine dritte Stufe liesse sich hier einhaengen, ohne dass
 * grossForNet oder die Verteilung etwas davon mitbekommen muessten.
 */
export const BREAK_STEPS = [
	{ afterHours: 6, deduction: 0.75 },
	{ afterHours: 4, deduction: 0.25 }
] as const;

/** Der Pausenabzug fuer eine Tages-Arbeitszeit, in Stunden. */
export function breakDeduction(workedHours: number): number {
	for (const step of BREAK_STEPS) {
		if (workedHours > step.afterHours) return step.deduction;
	}
	return 0;
}

/**
 * Den Pausenabzug eines Tages anteilig auf dessen Aktivitaeten verteilen - anteilig,
 * damit das Ergebnis nicht von der Reihenfolge der Eintraege abhaengt.
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
