import { untrack } from "svelte";
import { app } from "../app.svelte";

/**
 * Tray-Icon und -Menü nachziehen, sobald dieses Fenster trayVersion erhöht.
 * Nicht direkt an running/activities: trayVersion steigt erst im stabilen
 * Zustand, sonst sprang das Icon während reload() kurz auf „idle“.
 *
 * Hauptfenster und Tray-Flyout rufen das beide auf: jedes hat seinen eigenen
 * App-Zustand, und das Flyout soll das Tray auch bei geschlossenem
 * Hauptfenster aktuell halten. Nur während der Initialisierung einer Komponente aufrufbar.
 */
export function keepTrayInSync(): void {
	$effect(() => {
		if (!app.loaded) return;
		void app.trayVersion;
		untrack(() => void app.updateTrayState());
	});
}
