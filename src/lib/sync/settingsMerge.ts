// Die Einstellungen feldweise - siehe fieldMerge.ts. Besonderheiten: ein
// fehlendes Feld ist die Voreinstellung, und Gesendet-Vermerke werden vereinigt.
import { defaultSettings, type Settings, type SyncMeta } from "../types";
import {
	lostLocalField as lostField,
	mergeFields,
	stampFields as stamp,
	type FieldRules
} from "./fieldMerge";

export { sameFields as sameSettings } from "./fieldMerge";

/** Einstellungen samt Abgleich-Spuren, wie sie auf der Platte und beim Server liegen. */
export type StampedSettings = Settings & SyncMeta;

const SETTINGS_FIELDS: FieldRules = { defaults: defaultSettings };

/**
 * Feldstempel für einen Schreibvorgang. Auf einem frischen Gerät (`before`
 * null) zählt nur, was von der Voreinstellung abweicht - sonst schöbe es seine
 * Voreinstellungen über das, was das Konto längst eingestellt hat.
 */
export function stampFields(
	before: StampedSettings | null,
	after: StampedSettings,
	now: number
): StampedSettings {
	return stamp(before, after, now, SETTINGS_FIELDS);
}

/** Zwei Stände feldweise zusammenführen; ein Monat ist erledigt, sobald ein Gerät ihn so vermerkt. */
export function mergeSettings(local: StampedSettings, remote: StampedSettings): StampedSettings {
	const merged = mergeFields(local, remote, SETTINGS_FIELDS);
	const sent = [...(local.reportSentMonths ?? []), ...(remote.reportSentMonths ?? [])];
	return { ...merged, reportSentMonths: [...new Set(sent)].sort() };
}

export function lostLocalField(local: StampedSettings, merged: StampedSettings): boolean {
	return lostField(local, merged, SETTINGS_FIELDS);
}
