// Was beide Wege, ein Konto anzulegen, gemeinsam aus dem Request lesen: der
// Passkey-Weg (api/auth/register/finish) und der Weg vom Rechner aus
// (api/auth/device).
import { error } from "@sveltejs/kit";
import type { DbLike } from "./db/index";
import { consumeInviteCode, isValidInviteCode } from "./invites";
import { cleanEmail } from "$shared/email";
import { isLabelTooLong, LABEL_MAX, readLabel } from "$shared/labels";

export interface RegistrationFields {
	/** Der gewünschte Name - ohne Angabe die Kennung des Kontos. */
	displayName: string;
	/** Der Einladungscode. Geprüft, aber noch nicht entwertet. */
	code: string;
	email: string | null;
}

/**
 * Den Anzeigenamen einer Registrierung lesen. Anders als beim späteren
 * Umbenennen wird ein zu langer abgelehnt statt gekürzt: hier sieht der
 * Mensch noch das Formular und kann ihn selbst kürzen.
 */
export function readDisplayName(input: unknown, fallback: string): string {
	if (isLabelTooLong(input, LABEL_MAX)) error(400, "Anzeigename ist zu lang");
	return readLabel(input, fallback, LABEL_MAX);
}

/** Den Einladungscode prüfen (nicht entwerten) - wirft 403, wenn er nicht gilt. */
export function checkInviteCode(db: DbLike, input: unknown): string {
	const code = String(input ?? "").trim();
	if (!isValidInviteCode(db, code)) error(403, "Einladungscode ungültig");
	return code;
}

/**
 * Den Code entwerten - innerhalb der Transaktion, die das Konto anlegt. Wirft
 * 403, wenn er seit der Prüfung verbraucht, zurückgezogen oder abgelaufen ist;
 * die Transaktion rollt dann zurück.
 */
export function redeemInviteCode(tx: DbLike, code: string, userId: string): void {
	if (!consumeInviteCode(tx, code, userId)) error(403, "Einladungscode ungültig");
}

/**
 * Name, Einladungscode und E-Mail lesen und prüfen.
 *
 * Entwertet wird der Code hier nicht: das gehört in dieselbe Transaktion wie
 * das Anlegen des Kontos (redeemInviteCode), sonst ist er verbraucht, wenn
 * diese scheitert.
 */
export function readRegistrationFields(
	db: DbLike,
	body: { displayName?: unknown; invite?: unknown; email?: unknown } | null,
	userId: string
): RegistrationFields {
	const displayName = readDisplayName(body?.displayName, userId);
	const code = checkInviteCode(db, body?.invite);

	// Leer heisst "keine Angabe"; etwas Angegebenes, das keine einzelne Adresse
	// ist, wird abgelehnt statt still verworfen.
	let email: string | null = null;
	if (typeof body?.email === "string" && body.email.trim()) {
		email = cleanEmail(body.email)?.toLowerCase() ?? null;
		if (!email) error(400, "E-Mail-Adresse ist ungültig");
	}

	return { displayName, code, email };
}
