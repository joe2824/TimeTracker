// Nach dem Beitritt heissen eigene Aktivitäten oft genauso wie die des Teams.
// Hier steht, welche Paare zur Wahl stehen und was mit der Antwort geschieht.
import { app } from "../app.svelte";
import { isBuiltinActivity, type Activity } from "../types";
import { isJoinedTeamRow, withActivitiesLock } from "./activities";

export interface MergeCandidate {
	own: Activity;
	team: Activity;
}

const nameKey = (a: Activity): string => a.name.trim().toLocaleLowerCase("de");

/** Unter welchem Schlüssel ein abgelehntes Paar gemerkt wird. */
export const mergeKey = (c: MergeCandidate): string => `${c.own.id}>${c.team.id}`;

/**
 * Eigene Aktivitäten, die wie eine Team-Aktivität heissen - ohne die Paare, die
 * schon abgelehnt wurden. Archivierte und eingebaute Zeilen bleiben aussen vor,
 * ebenso die selbst verwalteten Team-Listen (dort führt der Aktivitäten-Tab
 * von Hand zusammen).
 */
export function findMergeCandidates(activities: Activity[], declined: readonly string[] = []): MergeCandidate[] {
	const teamByName = new Map<string, Activity>();
	for (const a of activities) {
		if (isJoinedTeamRow(a) && !a.archived && !a.isAbsence && !teamByName.has(nameKey(a))) {
			teamByName.set(nameKey(a), a);
		}
	}
	const skip = new Set(declined);
	const out: MergeCandidate[] = [];
	for (const own of activities) {
		if (own.teamOwned || own.archived || own.isAbsence || isBuiltinActivity(own)) continue;
		const team = teamByName.get(nameKey(own));
		if (team && !skip.has(mergeKey({ own, team }))) out.push({ own, team });
	}
	return out;
}

/**
 * Die Antwort umsetzen: die gewählten eigenen Aktivitäten gehen in ihrer
 * Team-Aktivität auf, die übrigen Paare gelten als abgelehnt. Liefert, wie
 * viele zusammengeführt wurden.
 */
export async function resolveMergeOffer(
	candidates: MergeCandidate[],
	selectedOwnIds: ReadonlySet<string>
): Promise<number> {
	let merged = 0;
	const declined: string[] = [];
	for (const c of candidates) {
		if (!selectedOwnIds.has(c.own.id)) {
			declined.push(mergeKey(c));
			continue;
		}
		await withActivitiesLock(() => app.mergeActivityInto(c.own.id, c.team.id));
		merged++;
	}
	if (declined.length > 0) {
		const known = app.settings.teamMergeDeclined ?? [];
		await app.updateSettings({ teamMergeDeclined: [...new Set([...known, ...declined])] });
	}
	return merged;
}
