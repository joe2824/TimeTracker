import type { Settings } from "./types";

/**
 * Die Einstellungs-Schluessel, deren Wert sich zwischen zwei Staenden geaendert hat.
 *
 * Die Einstellungs-Seite arbeitet mit lokalen Kopien der Werte (Eingabefelder,
 * die erst beim Verlassen speichern). Aendert jemand ANDERES die Einstellungen –
 * der Willkommens-Assistent, das Tray-Fenster ueber reload() –, muessen genau
 * diese Felder nachgezogen werden: sonst zeigt das Formular weiter den Stand von
 * seinem Aufbau UND schreibt ihn beim naechsten Speichern zurueck. Genau so
 * verschwand die im Assistenten eingetragene Adresse der Vorgesetzten wieder,
 * sobald man in den Einstellungen irgendetwas anfasste.
 *
 * Nur die GEAENDERTEN Schluessel, nicht einfach alle Felder neu befuellen: sonst
 * loeschte ein Speichern in einer anderen Karte eine gerade getippte, noch nicht
 * bestaetigte Eingabe.
 */
export function changedSettingKeys(prev: Settings, next: Settings): Set<keyof Settings> {
	const out = new Set<keyof Settings>();
	for (const key of Object.keys(next) as (keyof Settings)[]) {
		if (!sameValue(prev[key], next[key])) out.add(key);
	}
	return out;
}

/**
 * Werte-Vergleich. Listen und Zuordnungen (Erinnerungszeiten, Arbeitstage,
 * Stichwoerter) inhaltlich vergleichen: sie werden bei jedem Speichern neu
 * aufgebaut, waeren also nach Identitaet immer "geaendert".
 */
function sameValue(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
	return JSON.stringify(a) === JSON.stringify(b);
}
