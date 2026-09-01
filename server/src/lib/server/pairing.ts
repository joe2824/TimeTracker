// Die Form eines Kopplungscodes.

/** Ohne I, O, 0 und 1 - die werden beim Abschreiben verwechselt. */
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/** Zwoelf Stellen zu je fuenf Bit. Muss zu src/lib/crypto/vault.ts passen. */
export const PAIRING_CODE_LENGTH = 12;

/** Auf die Form bringen, in der verglichen wird. */
export function normalizeCode(input: unknown): string {
	return [...String(input ?? "").toUpperCase()].filter((c) => ALPHABET.includes(c)).join("");
}

/** Ob eine bereits normalisierte Zeichenkette die Form eines Codes hat. */
export function isPairingCode(code: string): boolean {
	return code.length === PAIRING_CODE_LENGTH && [...code].every((c) => ALPHABET.includes(c));
}

/**
 * Laenge des Abhol-Geheimnisses als Hex-Hash (SHA-256).
 *
 * Geprueft wird nur die FORM. Was der Hash wert ist, entscheidet sich auf dem
 * Geraet, das das Geheimnis wuerfelt - der Server sieht es nie.
 */
export const CLAIM_HASH_LENGTH = 64;

/** Ob eine Zeichenkette die Form eines Abhol-Hashes hat. */
export function isClaimHash(hash: string): boolean {
	return hash.length === CLAIM_HASH_LENGTH && /^[0-9a-f]+$/.test(hash);
}
