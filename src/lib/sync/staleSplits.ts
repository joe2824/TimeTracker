// Offene Rückfragen zu Mitternachts-Teilungen über einen Neustart hinweg.
import type { Entry } from "../types";
import type { StaleTimerSplitInfo } from "./engine";
import {
	listEntryMonths,
	loadEntries,
	loadStaleSplits,
	saveStaleSplits,
	type StaleSplitIds
} from "../store";
import { startOfNextDay } from "../time/time";

const keyOf = (p: StaleSplitIds) => `${p.endedId}/${p.continuationId}`;

const idsOf = (s: StaleTimerSplitInfo): StaleSplitIds => ({
	endedId: s.endedEntry.id,
	continuationId: s.continuationEntry.id
});

/**
 * Ob die Frage noch steht: der Lauf endet vor Mitternacht, und die
 * Fortsetzung beginnt genau dort. Reicht der Lauf wieder bis zur Fortsetzung
 * oder ist eines der Stücke umgezogen, wurde sie inzwischen beantwortet.
 */
function stillStale(ended: Entry, continuation: Entry): boolean {
	return (
		ended.activityId === continuation.activityId &&
		ended.endTs !== null &&
		ended.endTs < continuation.startTs &&
		continuation.startTs === startOfNextDay(ended.startTs)
	);
}

/** Einträge nach Id, die jüngsten Monate zuerst - die Teilungen liegen dort. */
async function findEntries(ids: Set<string>): Promise<Map<string, Entry>> {
	const found = new Map<string, Entry>();
	if (ids.size === 0) return found;
	for (const month of await listEntryMonths()) {
		for (const e of await loadEntries(month)) if (ids.has(e.id)) found.set(e.id, e);
		if (found.size === ids.size) break;
	}
	return found;
}

/**
 * Die abgelegten Fragen mit dem heutigen Stand der Platte. Was nicht mehr
 * steht, fällt heraus - auch aus der Datei.
 */
export async function restoreStaleSplits(): Promise<StaleTimerSplitInfo[]> {
	const pairs = await loadStaleSplits();
	if (pairs.length === 0) return [];
	const entries = await findEntries(new Set(pairs.flatMap((p) => [p.endedId, p.continuationId])));
	const out: StaleTimerSplitInfo[] = [];
	for (const p of pairs) {
		const endedEntry = entries.get(p.endedId);
		const continuationEntry = entries.get(p.continuationId);
		if (endedEntry && continuationEntry && stillStale(endedEntry, continuationEntry)) {
			out.push({ endedEntry, continuationEntry });
		}
	}
	if (out.length !== pairs.length) await saveStaleSplits(out.map(idsOf));
	return out;
}

/** Neue Fragen dazulegen; dieselbe zweimal gibt es nicht. */
export async function rememberStaleSplits(found: StaleTimerSplitInfo[]): Promise<void> {
	if (found.length === 0) return;
	const pairs = await loadStaleSplits();
	const known = new Set(pairs.map(keyOf));
	for (const s of found) {
		const ids = idsOf(s);
		if (known.has(keyOf(ids))) continue;
		known.add(keyOf(ids));
		pairs.push(ids);
	}
	await saveStaleSplits(pairs);
}

/** Eine beantwortete Frage austragen. */
export async function forgetStaleSplit(s: StaleTimerSplitInfo): Promise<void> {
	const key = keyOf(idsOf(s));
	await saveStaleSplits((await loadStaleSplits()).filter((p) => keyOf(p) !== key));
}

/** Alle Fragen verwerfen - sie gehören dem Konto, das dieses Gerät verlässt. */
export function clearStaleSplits(): Promise<void> {
	return saveStaleSplits([]);
}
