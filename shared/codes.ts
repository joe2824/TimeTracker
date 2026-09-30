// Die Form der Codes, die ein Mensch abtippt - Kopplung und Einladung.
//
// Client und Server müssen sich hier auf das Zeichen genau einig sein: der
// Server nimmt einen Code nur an, wenn er dieselbe Form erwartet, die der
// Client gerechnet hat. Deshalb steht das hier einmal und nicht in beiden.

/** Ohne I, O, 0 und 1 - die werden beim Abschreiben verwechselt. */
export const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/** Zwölf Stellen zu je fünf Bit. Siehe pairingCode in src/lib/crypto/vault.ts. */
export const PAIRING_CODE_LENGTH = 12;

/** Nur die Alphabet-Zeichen, grossgeschrieben - Leerzeichen, Striche und Tippfehler fallen weg. */
function alphabetOnly(input: unknown): string {
	return [...String(input ?? "").toUpperCase()].filter((c) => CODE_ALPHABET.includes(c)).join("");
}

/** Getipptes auf die Rechenform bringen: Grossschreibung, nur Alphabet-Zeichen. */
export function normalizePairingCode(input: unknown): string {
	return alphabetOnly(input);
}

/** Ob eine bereits normalisierte Zeichenkette die Form eines Codes hat. */
export function isPairingCode(code: string): boolean {
	return (
		code.length === PAIRING_CODE_LENGTH && [...code].every((c) => CODE_ALPHABET.includes(c))
	);
}

// ---------- Einladungscodes ----------
//
// Konto-, Team- und Verwalter-Einladungen haben dieselbe Form: vier Gruppen zu
// je vier Zeichen aus CODE_ALPHABET, durch "-" getrennt (ABCD-EFGH-JKLM-NPQR).

export const INVITE_CODE_GROUPS = 4;
export const INVITE_CODE_GROUP_LENGTH = 4;

/**
 * Getippten Einladungscode auf die gespeicherte Form bringen: Kleinschreibung,
 * fehlende oder zusätzliche Striche und Leerzeichen werden verziehen. Hat das
 * Ergebnis nicht die Länge eines Codes, bleibt es ungruppiert - es passt dann
 * ohnehin auf keinen.
 */
export function normalizeInviteCode(input: unknown): string {
	const chars = alphabetOnly(input);
	if (chars.length !== INVITE_CODE_GROUPS * INVITE_CODE_GROUP_LENGTH) return chars;
	const groups: string[] = [];
	for (let i = 0; i < chars.length; i += INVITE_CODE_GROUP_LENGTH) {
		groups.push(chars.slice(i, i + INVITE_CODE_GROUP_LENGTH));
	}
	return groups.join("-");
}

/** Ob eine bereits normalisierte Zeichenkette die Form eines Einladungscodes hat. */
export function isInviteCode(code: string): boolean {
	return (
		code.length === INVITE_CODE_GROUPS * (INVITE_CODE_GROUP_LENGTH + 1) - 1 &&
		normalizeInviteCode(code) === code
	);
}

// ---------- Wie lange eine WebAuthn-Aufgabe gilt ----------

/** Was der Server einer Aufgabe zugesteht. */
export const CHALLENGE_TTL_MS = 5 * 60 * 1000;

/**
 * Wie lange der Client eine vorgeladene Aufgabe liegen lässt.
 *
 * Knapp darunter: eine Aufgabe, die hier noch als frisch gilt, während der
 * Server sie schon verworfen hat, lässt die Anmeldung ohne erkennbaren Grund
 * scheitern. Deshalb hängt der Wert am Server-Wert und steht nicht daneben.
 */
export const CHALLENGE_REUSE_MS = CHALLENGE_TTL_MS - 60 * 1000;
