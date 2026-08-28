// Die Spuren des Abgleichs aus dem lokalen Bestand nehmen.
import {
	listEntryMonths,
	loadActivities,
	loadEntries,
	loadSettings,
	saveActivities,
	saveEntries,
	saveSettings
} from "../store";
import { applyingRemote, clearChanges, pendingChanges } from "./outbox";
import type { Settings, SyncMeta } from "../types";

/** Die drei Stempelfelder abstreifen - und sonst nichts anfassen. */
function ohneStempel<T extends SyncMeta>(item: T): T {
	const { updatedAt: _u, rev: _r, deviceId: _d, ...rest } = item;
	return rest as T;
}

/** Ob an einem Datensatz ueberhaupt ein Stempel haengt. */
function gestempelt(item: SyncMeta): boolean {
	return item.updatedAt !== undefined || item.rev !== undefined || item.deviceId !== undefined;
}

export interface DetachResult {
	months: number;
	entries: number;
	activities: number;
}

/** Den lokalen Bestand vom Konto loesen - nur die Stempelfelder, kein einziger Eintrag. */
export async function detachLocalData(): Promise<DetachResult> {
	return applyingRemote(async () => {
		const ergebnis: DetachResult = { months: 0, entries: 0, activities: 0 };

		for (const monat of await listEntryMonths()) {
			const eintraege = await loadEntries(monat);
			if (!eintraege.some(gestempelt)) continue;
			await saveEntries(monat, eintraege.map(ohneStempel));
			ergebnis.months++;
			ergebnis.entries += eintraege.length;
		}

		const aktivitaeten = await loadActivities();
		if (aktivitaeten.some(gestempelt)) {
			await saveActivities(aktivitaeten.map(ohneStempel));
			ergebnis.activities = aktivitaeten.length;
		}

		// Die Einstellungen tragen die Stempel als Zusatzfelder - sie sind kein
		// SyncMeta, bekommen aber beim Abgleich dieselben drei Felder angehaengt.
		const einstellungen = (await loadSettings()) as Settings & SyncMeta;
		if (gestempelt(einstellungen)) await saveSettings(ohneStempel(einstellungen));

		// Was noch offen war, bezog sich auf ein Konto, das dieses Geraet nicht mehr
		// hat. Stehen zu lassen hiesse: beim naechsten Koppeln wird als Erstes eine
		// Handvoll uralter Aenderungen hochgeladen, die niemand mehr erwartet.
		await clearChanges(pendingChanges());

		return ergebnis;
	});
}
