// Die Form der Codes, die ein Mensch abtippt - Kopplung und Einladung.
//
// Client und Server muessen sich hier auf das Zeichen genau einig sein: der
// Server nimmt einen Code nur an, wenn er dieselbe Form erwartet, die der
// Client gerechnet hat. Deshalb steht das hier einmal und nicht in beiden.

/** Ohne I, O, 0 und 1 - die werden beim Abschreiben verwechselt. */
export const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/** Zwoelf Stellen zu je fuenf Bit. Siehe pairingCode in src/lib/crypto/vault.ts. */
export const PAIRING_CODE_LENGTH = 12;

/** Getipptes auf die Rechenform bringen: Grossschreibung, nur Alphabet-Zeichen. */
export function normalizePairingCode(input: unknown): string {
	return [...String(input ?? "").toUpperCase()].filter((c) => CODE_ALPHABET.includes(c)).join("");
}

/** Ob eine bereits normalisierte Zeichenkette die Form eines Codes hat. */
export function isPairingCode(code: string): boolean {
	return (
		code.length === PAIRING_CODE_LENGTH && [...code].every((c) => CODE_ALPHABET.includes(c))
	);
}
