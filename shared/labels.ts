// Frei getippte Namen und Bezeichnungen - wie lang sie sein dürfen und wie
// der Server sie liest.

/** Anzeigename eines Kontos, Name eines Geräts oder Passkeys. */
export const LABEL_MAX = 64;

/** Namen im Team-Modus: Team, Mitglied, Aktivität, Berichtszeile. */
export const TEAM_TEXT_MAX = 100;

/**
 * Getrimmt und auf `max` Zeichen gekürzt - leer oder kein Text ergibt
 * `fallback`.
 */
export function readLabel<F extends string | null>(input: unknown, fallback: F, max: number): string | F {
	const text = typeof input === "string" ? input.trim().slice(0, max).trim() : "";
	return text || fallback;
}

/** Ob ein Text nach dem Trimmen länger als `max` ist - für Stellen, die ablehnen statt zu kürzen. */
export function isLabelTooLong(input: unknown, max: number): boolean {
	return typeof input === "string" && input.trim().length > max;
}
