// Datensaetze fuer Tests, mit brauchbaren Vorgaben. Was ein Test wirklich
// braucht, ueberschreibt er - der Rest steht hier, damit nicht jede Datei
// dasselbe Objekt noch einmal ausschreibt.
import type { Activity, Entry } from "../types";

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
