// Die Einstellungen feldweise - siehe fieldMerge.ts. Besonderheiten: ein
// fehlendes Feld ist die Voreinstellung, und was nur wächst, wird vereinigt.
import { defaultSettings, type Settings, type SyncMeta } from "../types";
import { mergeFields, type FieldRules } from "./fieldMerge";

/** Einstellungen samt Abgleich-Spuren, wie sie auf der Platte und beim Server liegen. */
export type StampedSettings = Settings & SyncMeta;

/**
 * Ein fehlendes Feld ist die Voreinstellung. Auf einem frischen Gerät zählt
 * damit nur, was davon abweicht - sonst schöbe es seine Voreinstellungen über
 * das, was das Konto längst eingestellt hat.
 */
export const SETTINGS_FIELDS: FieldRules = { defaults: defaultSettings };

const union = (a: string[] | undefined, b: string[] | undefined): string[] =>
	[...new Set([...(a ?? []), ...(b ?? [])])].sort();

/**
 * Zwei Stände feldweise zusammenführen. Gesendet-Vermerke, abgelehnte
 * Zusammenführungen und Stichwort-Zuordnungen wachsen nur: was ein Gerät
 * dazugelernt hat, darf das andere nicht verdrängen. Bei einem Stichwort, das
 * beide kennen, gilt die jüngere Zuordnung.
 */
export function mergeSettings(local: StampedSettings, remote: StampedSettings): StampedSettings {
	const merged = mergeFields(local, remote, SETTINGS_FIELDS);
	return {
		...merged,
		reportSentMonths: union(local.reportSentMonths, remote.reportSentMonths),
		teamMergeDeclined: union(local.teamMergeDeclined, remote.teamMergeDeclined),
		calendarKeywordMap: {
			...local.calendarKeywordMap,
			...remote.calendarKeywordMap,
			...merged.calendarKeywordMap
		}
	};
}
