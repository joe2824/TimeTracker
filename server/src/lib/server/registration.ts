// Was beide Wege, ein Konto anzulegen, gemeinsam aus dem Request lesen: der
// Passkey-Weg (api/auth/register/finish) und der Weg vom Rechner aus
// (api/auth/device).
import { error } from "@sveltejs/kit";
import type { DbLike } from "./db";
import { isRegistrationOpen, validCode } from "./invites";

export interface RegistrationFields {
	/** Der gewuenschte Name - ohne Angabe die Kennung des Kontos. */
	displayName: string;
	/** Der Einladungscode. Geprueft, aber noch nicht entwertet. */
	code: string;
	email: string | null;
}

/**
 * Name, Einladungscode und E-Mail lesen und pruefen.
 *
 * Entwertet wird der Code hier nicht: das gehoert in dieselbe Transaktion wie
 * das Anlegen des Kontos, sonst ist er verbraucht, wenn diese scheitert.
 */
export function readRegistrationFields(
	db: DbLike,
	body: { displayName?: unknown; invite?: unknown; email?: unknown } | null,
	userId: string
): RegistrationFields {
	const requested = String(body?.displayName ?? "").trim();
	if (requested.length > 64) error(400, "Anzeigename ist zu lang");

	const code = String(body?.invite ?? "").trim();
	if (!isRegistrationOpen(db) && !validCode(db, code)) {
		error(403, "Einladungscode ungültig");
	}

	return {
		displayName: requested || userId,
		code,
		email: body?.email ? String(body.email).trim().toLowerCase() : null
	};
}
