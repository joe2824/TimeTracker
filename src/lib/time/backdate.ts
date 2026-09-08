// Was passiert mit bestehenden Zeiten, wenn ein Timer rückdatiert startet?
// Reine Logik – die Regel soll testbar sein, nicht im Klick-Handler stecken.
import type { Entry } from "../types";

export interface BackdatePlan {
	/** Einträge, die auf `endTs` gekürzt werden (der neue Start schneidet sie an) */
	truncate: { entry: Entry; endTs: number }[];
	/** Einträge, die der neue Zeitraum vollständig überdeckt */
	remove: Entry[];
}

/**
 * Der neue Timer belegt [start, offen). Für jeden bestehenden Eintrag gilt:
 *
 * - endet vor dem Start          -> unberührt
 * - beginnt am/nach dem Start    -> vollständig überdeckt -> entfernen
 * - wird angeschnitten           -> auf `start` kürzen
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
		if (e.endTs === null) {
			if (e.startTs >= start) remove.push(e);
			else truncate.push({ entry: e, endTs: start });
			continue;
		}
		const end = e.endTs;
		if (end <= start) continue;
		if (e.startTs >= start) remove.push(e);
		else truncate.push({ entry: e, endTs: start });
	}
	return { truncate, remove };
}

export function planIsEmpty(plan: BackdatePlan): boolean {
	return plan.truncate.length === 0 && plan.remove.length === 0;
}

/** Muss vorher gefragt werden? */
export function planNeedsConfirm(plan: BackdatePlan): boolean {
	return plan.truncate.some((t) => t.entry.endTs !== null) || plan.remove.length > 0;
}
