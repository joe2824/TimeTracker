// Womit der Dialog „Neuer Eintrag“ seine Zeiten vorbelegt.
import type { Entry } from "../types";
import { fmtDate } from "./time";

/**
 * Der Zeitpunkt, an dem ein neuer Eintrag an `date` lückenlos anschliesst: das
 * späteste Ende eines abgeschlossenen Arbeitseintrags, der an diesem Tag
 * beginnt UND endet. `null`, wenn es keinen gibt.
 *
 * Ein Ende um Mitternacht oder danach zählt nicht: als Uhrzeit dieses Tages
 * gelesen wäre es dessen Anfang.
 */
export function continuationStart(
	entries: Entry[],
	date: string,
	absenceIds: Set<string>
): number | null {
	let latest: number | null = null;
	for (const e of entries) {
		if (e.endTs === null || absenceIds.has(e.activityId)) continue;
		if (latest !== null && e.endTs <= latest) continue;
		if (fmtDate(e.startTs) !== date || fmtDate(e.endTs) !== date) continue;
		latest = e.endTs;
	}
	return latest;
}
