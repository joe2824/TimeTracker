import type { Settings } from "../types";
import { clockToMin, minToClock } from "../time/time";

/** Die Einstellungs-Schlüssel, deren Wert sich zwischen zwei Ständen geändert hat. */
export function changedSettingKeys(prev: Settings, next: Settings): Set<keyof Settings> {
	const out = new Set<keyof Settings>();
	for (const key of Object.keys(next) as (keyof Settings)[]) {
		if (!sameValue(prev[key], next[key])) out.add(key);
	}
	return out;
}

/**
 * Werte-Vergleich. Listen und Zuordnungen (Erinnerungszeiten, Arbeitstage,
 * Stichwörter) inhaltlich vergleichen: sie werden bei jedem Speichern neu
 * aufgebaut, wären also nach Identität immer "geändert".
 */
function sameValue(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
	return JSON.stringify(a) === JSON.stringify(b);
}

// ---------- Formular der Einstellungs-Seite ----------

/** Einstellungen, die als Text im Eingabefeld stehen. */
type TextKey =
	| "rounding"
	| "hoursPerDay"
	| "reportReminderLeadDays"
	| "idleThresholdMin"
	| "maxTimerHours"
	| "pomodoroMin"
	| "pomodoroBreakMin";

/** Arbeitskopie der Einstellungen, wie die Seite sie bindet. */
export type SettingsForm = Omit<Settings, TextKey> & Record<TextKey, string>;

/** Die Umrechnung Einstellung -> Feldinhalt; alles Übrige wird 1:1 kopiert. */
const TO_FORM: { [K in TextKey]: (s: Settings) => string } = {
	rounding: (s) => String(s.rounding),
	hoursPerDay: (s) => minToClock(s.hoursPerDay * 60),
	reportReminderLeadDays: (s) => String(s.reportReminderLeadDays),
	idleThresholdMin: (s) => String(s.idleThresholdMin),
	maxTimerHours: (s) => String(s.maxTimerHours),
	pomodoroMin: (s) => String(s.pomodoroMin),
	pomodoroBreakMin: (s) => String(s.pomodoroBreakMin)
};

/** Die Umrechnung Feldinhalt -> Einstellung, samt Grenzen und Rückfall. */
const TO_SETTING: {
	[K in keyof Settings]?: (raw: SettingsForm[K], stored: Settings) => Settings[K];
} = {
	bossEmail: (raw) => raw.trim(),
	senderName: (raw) => raw.trim(),
	reportSubjectTemplate: (raw, s) => raw.trim() || s.reportSubjectTemplate,
	rounding: (raw, s) => Number(raw) || s.rounding,
	hoursPerDay: (raw, s) => {
		const min = clockToMin(raw) ?? 0;
		return min > 0 ? min / 60 : s.hoursPerDay;
	},
	workdays: (raw) => [...raw].sort((a, b) => a - b),
	reminderTimes: (raw) => raw.map((t) => t.trim()).filter(Boolean),
	reportReminderTime: (raw, s) => raw.trim() || s.reportReminderTime,
	// Auch nach oben begrenzen: max="10" am Feld hält eine getippte 40 nicht auf,
	// und ein zu grosser Vorlauf schöbe das Ziel in die Vergangenheit.
	reportReminderLeadDays: (raw) => Math.min(10, Math.max(0, Number(raw) || 0)),
	idleThresholdMin: (raw) => Math.max(0, Number(raw) || 0),
	maxTimerHours: (raw) => Math.max(0, Number(raw) || 0),
	pomodoroMin: (raw, s) => Math.max(1, Number(raw) || s.pomodoroMin),
	pomodoroBreakMin: (raw) => Math.max(0, Number(raw) || 0)
};

/** Arbeitskopie aus einem Einstellungsstand aufbauen (Listen als eigene Kopie). */
export function formFromSettings(s: Settings): SettingsForm {
	return { ...structuredClone(s), ...mapValues(TO_FORM, (fn) => fn(s)) } as SettingsForm;
}

/**
 * Geänderte Einstellungen in die Arbeitskopie nachziehen. Gibt den Stand
 * zurück, gegen den beim nächsten Mal verglichen wird.
 */
export function syncForm(form: SettingsForm, prev: Settings, next: Settings): Settings {
	const fresh = formFromSettings(next);
	for (const key of changedSettingKeys(prev, next)) assign(form, key, fresh[key]);
	return next;
}

/**
 * Aus der Arbeitskopie den Patch für die genannten Schlüssel bauen – und die
 * übernommenen Werte im Formular normalisieren (getrimmt, "07:30" statt "7:3").
 */
export function patchFrom(
	form: SettingsForm,
	keys: readonly (keyof Settings)[],
	stored: Settings
): Partial<Settings> {
	const patch: Partial<Settings> = {};
	for (const key of keys) {
		const convert = TO_SETTING[key] as ((raw: unknown, s: Settings) => unknown) | undefined;
		const value = convert ? convert(form[key], stored) : structuredClone(form[key]);
		assign(patch, key, value);
		const back = TO_FORM[key as TextKey];
		if (back) assign(form, key, back({ ...stored, ...patch } as Settings));
		else if (typeof form[key] === "string") assign(form, key, value);
	}
	return patch;
}

/** Schreibender Zugriff über einen zur Laufzeit gewählten Schlüssel. */
function assign(target: object, key: PropertyKey, value: unknown): void {
	(target as Record<PropertyKey, unknown>)[key] = value;
}

function mapValues<K extends string, A, B>(
	obj: Record<K, A>,
	fn: (value: A) => B
): Record<K, B> {
	const out = {} as Record<K, B>;
	for (const key of Object.keys(obj) as K[]) out[key] = fn(obj[key]);
	return out;
}
