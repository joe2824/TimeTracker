// Die Form eines Kopplungscodes.

/** Ohne I, O, 0 und 1 - die werden beim Abschreiben verwechselt. */
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/** Zwoelf Stellen zu je fuenf Bit. Muss zu src/lib/crypto/vault.ts passen. */
export const PAIRING_CODE_LENGTH = 12;

/** Auf die Form bringen, in der verglichen wird. */
export function normalisiereCode(eingabe: unknown): string {
	return [...String(eingabe ?? "").toUpperCase()].filter((c) => ALPHABET.includes(c)).join("");
}

/** Ob eine bereits normalisierte Zeichenkette die Form eines Codes hat. */
export function istPairingCode(code: string): boolean {
	return code.length === PAIRING_CODE_LENGTH && [...code].every((c) => ALPHABET.includes(c));
}
