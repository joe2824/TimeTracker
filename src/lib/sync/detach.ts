// Die Spuren des Abgleichs aus dem lokalen Bestand nehmen.
import { listEntryMonths, listTimeReportMonths, remoteStore as store } from "../store";
import { clearChanges, pendingChanges } from "./outbox";
import type { Settings, SyncMeta } from "../types";

/** Die drei Stempelfelder abstreifen - und sonst nichts anfassen. */
function withoutStamp<T extends SyncMeta>(item: T): T {
	const { updatedAt: _u, rev: _r, deviceId: _d, ...rest } = item;
	return rest as T;
}

/** Ob an einem Datensatz überhaupt ein Stempel hängt. */
function stamped(item: SyncMeta): boolean {
	return item.updatedAt !== undefined || item.rev !== undefined || item.deviceId !== undefined;
}

export interface DetachResult {
	months: number;
	entries: number;
	activities: number;
	timeReports: number;
}

/**
 * Den lokalen Bestand vom Konto lösen - nur die Stempelfelder, kein einziger
 * Eintrag. Am Schreib-Haken vorbei (remoteStore): das Abstreifen ist keine
 * Änderung, die hochgeladen werden soll.
 */
export async function detachLocalData(): Promise<DetachResult> {
	const result: DetachResult = { months: 0, entries: 0, activities: 0, timeReports: 0 };

	for (const month of await listEntryMonths()) {
		const entries = await store.entriesOfMonth(month);
		if (!entries.some(stamped)) continue;
		await store.saveEntries(month, entries.map(withoutStamp));
		result.months++;
		result.entries += entries.length;
	}

	const activities = await store.activities();
	if (activities.some(stamped)) {
		await store.saveActivities(activities.map(withoutStamp));
		result.activities = activities.length;
	}

	// Die Einstellungen tragen die Stempel als Zusatzfelder - sie sind kein
	// SyncMeta, bekommen aber beim Abgleich dieselben drei Felder angehängt.
	const settings = (await store.settings()) as Settings & SyncMeta;
	if (stamped(settings)) await store.saveSettings(withoutStamp(settings));

	// Die eingelesenen Reports ebenso. Bliebe ihr Stempel stehen, hielte
	// rememberUnstamped sie für längst hochgeladen - beim nächsten Konto
	// wären sie nur noch lokal da, ohne dass es jemand bemerkt.
	for (const month of await listTimeReportMonths()) {
		const report = await store.timeReport(month);
		if (!report || !stamped(report)) continue;
		await store.saveTimeReport(withoutStamp(report));
		result.timeReports++;
	}

	// Was noch offen war, bezog sich auf ein Konto, das dieses Gerät nicht mehr
	// hat. Stehen zu lassen hiesse: beim nächsten Koppeln wird als Erstes eine
	// Handvoll uralter Änderungen hochgeladen, die niemand mehr erwartet.
	await clearChanges(pendingChanges());

	return result;
}
