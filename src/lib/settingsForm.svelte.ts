// Die Arbeitskopie der Einstellungen, wie sie jeder Einstellungs-Tab braucht:
// ein Formular, das Aenderungen von anderen Geraeten nachzieht, und ein
// Speichern, das nur die genannten Felder anfasst.
import { app } from "./app.svelte";
import { formFromSettings, patchFrom, syncForm, type SettingsForm } from "./settingsSync";
import type { Settings } from "./types";

/** Der gespeicherte Stand ohne Proxys - dagegen wird verglichen. */
function storedSettings(): Settings {
	return $state.snapshot(app.settings) as Settings;
}

export interface SettingsFormHandle {
	/** Die Arbeitskopie. Felder direkt daran binden. */
	form: SettingsForm;
	/** Die genannten Felder aus der Arbeitskopie speichern. */
	save(keys: readonly (keyof Settings)[]): Promise<void>;
}

/**
 * Im `<script>` des Tabs aufrufen, nicht spaeter: der Abgleich haengt an einem
 * `$effect`, und der gehoert in die Aufbauphase der Komponente.
 */
export function createSettingsForm(): SettingsFormHandle {
	const form = $state(formFromSettings(storedSettings()));
	let synced = storedSettings();

	// Was ein anderes Geraet aendert, kommt ueber den Abgleich herein und soll
	// auch in einem offenen Tab stehen - ohne zu ueberschreiben, was gerade
	// jemand tippt (siehe syncForm).
	$effect(() => {
		synced = syncForm(form, synced, storedSettings());
	});

	return {
		form,
		save: (keys) => app.updateSettings(patchFrom(form, keys, storedSettings()))
	};
}
