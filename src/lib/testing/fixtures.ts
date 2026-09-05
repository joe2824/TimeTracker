// Datensaetze fuer Tests, mit brauchbaren Vorgaben. Was ein Test wirklich
// braucht, ueberschreibt er - der Rest steht hier, damit nicht jede Datei
// dasselbe Objekt noch einmal ausschreibt.
import type { Activity, Entry } from "../types";

/** Der Monat, in dem die Testdaten liegen. */
export const MONTH = "2026-07";

/** Ein Zeitpunkt in `MONTH`, in der Zone der Testdaten (UTC+2). */
export const ts = (day: number, hour: number): number =>
	Date.UTC(2026, 6, day, hour) + 2 * 3600_000;

export const anEntry = (id: string, over: Partial<Entry> = {}): Entry => ({
	id,
	activityId: "a",
	startTs: 1000,
	endTs: 2000,
	note: "",
	source: "manual",
	...over
});

export const anActivity = (id: string, over: Partial<Activity> = {}): Activity => ({
	id,
	name: id,
	sortOrder: 0,
	archived: false,
	isAbsence: false,
	...over
});
