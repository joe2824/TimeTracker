// Eine einzelne E-Mail-Adresse - Server und Client müssen sich einig sein, was
// als Empfänger in einen Outlook-Entwurf darf (Trenner wie ";" und "," würden
// zusätzliche Empfänger einschleusen).

const ADDRESS = /^[^\s@;,<>()"\\]+@[^\s@;,<>()"\\]+\.[^\s@;,<>()"\\]+$/;

/** Die getrimmte Adresse, oder null, wenn es keine einzelne gültige ist. */
export function cleanEmail(input: unknown): string | null {
	if (typeof input !== "string") return null;
	const trimmed = input.trim();
	return trimmed.length <= 200 && ADDRESS.test(trimmed) ? trimmed : null;
}

/** Ein Feld, das leer bleiben darf, aber wenn nicht, genau eine gültige Adresse braucht. */
export function isInvalidOptionalEmail(input: string): boolean {
	return input.trim() !== "" && cleanEmail(input) === null;
}
