// Was passiert mit bestehenden Zeiten, wenn ein Timer rueckdatiert startet?
// Reine Logik – die Regel soll testbar sein, nicht im Klick-Handler stecken.
import type { Entry } from "./types";

export interface BackdatePlan {
	/** Eintraege, die auf `endTs` gekuerzt werden (der neue Start schneidet sie an) */
	truncate: { entry: Entry; endTs: number }[];
	/** Eintraege, die der neue Zeitraum vollstaendig ueberdeckt */
	remove: Entry[];
}

/**
 * Der neue Timer belegt [start, offen). Fuer jeden bestehenden Eintrag gilt:
 *
 * - endet vor dem Start          -> unberuehrt
 * - beginnt am/nach dem Start    -> vollstaendig ueberdeckt -> entfernen
 * - wird angeschnitten           -> auf `start` kuerzen
 *
 * Abwesenheiten bleiben aussen vor: die sind tagesgenau und haben keine Spanne.
 * Ein laufender Eintrag zaehlt bis `now`.
 */
export function planBackdate(
	entries: Entry[],
	start: number,
	absenceIds: Set<string>,
	now: number
): BackdatePlan {
	const truncate: { entry: Entry; endTs: number }[] = [];
	const remove: Entry[] = [];

	for (const e of entries) {
		if (absenceIds.has(e.activityId)) continue;
		const end = e.endTs ?? now;
		if (end <= start) continue;
		if (e.startTs >= start) remove.push(e);
		else truncate.push({ entry: e, endTs: start });
	}
	return { truncate, remove };
}

export function planIsEmpty(plan: BackdatePlan): boolean {
	return plan.truncate.length === 0 && plan.remove.length === 0;
}

/**
 * Muss vorher gefragt werden?
 *
 * Einen laufenden Timer zu KUERZEN ist der ganz normale Wechsel – dafuer jedes Mal
 * einen Dialog zu zeigen waere unertraeglich. Ihn ganz zu ENTFERNEN ist es nicht:
 * wer um 10:30 "ab 09:00" startet, waehrend seit 10:00 ein Timer laeuft, verlaere
 * dessen halbe Stunde sonst kommentarlos.
 *
 * Bei abgeschlossenen Zeiten wird immer gefragt.
 */
export function planNeedsConfirm(plan: BackdatePlan): boolean {
	return plan.truncate.some((t) => t.entry.endTs !== null) || plan.remove.length > 0;
}
