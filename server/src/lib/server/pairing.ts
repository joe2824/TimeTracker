// Die Form eines Kopplungscodes.
//
// Der Code ENTSTEHT nicht hier, sondern auf dem Geraet: er ist der Abdruck des
// oeffentlichen Schluessels, den das neue Geraet hinterlegt (SHA-256, zwoelf
// Stellen zu je fuenf Bit - siehe src/lib/crypto/vault.ts). Der Server rechnet
// das ausdruecklich NICHT nach.
//
// Das ist keine Nachlaessigkeit, sondern die Aufteilung selbst: die Bindung
// zwischen Code und Schluessel schuetzt gegen einen Server, der den hinterlegten
// Schluessel gegen einen eigenen tauscht. Eine Pruefung, die dieser Server selbst
// ausfuehrt, koennte er im selben Atemzug weglassen - sie bewiese niemandem
// etwas. Nachgerechnet wird auf beiden Geraeten, und nur dort zaehlt es.
//
// Was hier steht, ist deshalb bloss Hygiene: dass in der Spalte, die einen
// Vorgang benennt, ein Wert der erwarteten Form landet.

/** Ohne I, O, 0 und 1 - die werden beim Abschreiben verwechselt. */
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/** Zwoelf Stellen zu je fuenf Bit. Muss zu src/lib/crypto/vault.ts passen. */
export const PAIRING_CODE_LENGTH = 12;

/**
 * Auf die Form bringen, in der verglichen wird.
 *
 * Grossschreibung, und alles weg, was nicht zum Alphabet gehoert - vor allem die
 * Bindestriche, mit denen der Code angezeigt wird ("ABCD-EFGH-JKLM"). Die
 * Geraete schicken ihn zwar schon so, aber ein Endpunkt, der an einem
 * Bindestrich scheitert, waere eine Fehlersuche, die niemand braucht.
 */
export function normalisiereCode(eingabe: unknown): string {
	return [...String(eingabe ?? "").toUpperCase()].filter((c) => ALPHABET.includes(c)).join("");
}

/** Ob eine bereits normalisierte Zeichenkette die Form eines Codes hat. */
export function istPairingCode(code: string): boolean {
	return code.length === PAIRING_CODE_LENGTH && [...code].every((c) => ALPHABET.includes(c));
}
