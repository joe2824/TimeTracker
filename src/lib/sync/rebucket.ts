// Die Monatsdateien an die Kontozeitzone anpassen. In welche Datei ein Eintrag
// gehört, hängt an der Zone: der späte Abend des 31. ist anderswo schon der 1.
import { acrossWindows, loadEntryZone, rebucketEntryFiles, saveEntryZone } from "../store";
import { monthKey } from "../time/time";
import { appTimeZone } from "../time/tz";
import { createSerialQueue } from "../utils";
import { logInfo } from "../log";
import { relocateChanges } from "./outbox";

const serial = createSerialQueue();

/**
 * Jeden Eintrag in die Monatsdatei der jetzt geltenden Zone legen und die
 * Merkliste des Abgleichs mitziehen.
 *
 * Kostet nichts, solange die Zone dieselbe ist, in der zuletzt einsortiert
 * wurde. Über Fenster hinweg gesperrt: Haupt- und Tray-Fenster laden beide neu,
 * wenn die Zone wechselt.
 */
export function rebucketEntries(): Promise<void> {
	return serial(() =>
		acrossWindows("rebucket", async () => {
			const zone = appTimeZone();
			if ((await loadEntryZone()) === zone) return;
			const { moved, complete } = await rebucketEntryFiles(monthKey);
			await relocateChanges(moved);
			// Mit einer unlesbaren Datei ist nicht alles einsortiert: beim nächsten
			// Mal erneut prüfen.
			if (complete) await saveEntryZone(zone);
			if (moved.size > 0) logInfo("Einträge nach Zonenwechsel umsortiert", { zone, moved: moved.size });
		})
	);
}
