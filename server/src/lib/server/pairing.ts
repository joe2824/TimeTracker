// Die Form eines Kopplungscodes.
//
// Alphabet, Laenge und Pruefung stehen in shared/codes.ts - dieselbe Datei, die
// der Client benutzt. Nur so kann der Server nicht eine andere Form erwarten,
// als drueben gerechnet wird.
export { isPairingCode, normalizePairingCode, PAIRING_CODE_LENGTH } from "$shared/codes";

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
