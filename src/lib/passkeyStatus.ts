// Wovon haengt es ab, ob ein Browser sich reibungslos anmelden kann.
import type { Passkey } from "$lib/sync/api";

/**
 * Was diesem Browser fehlt: ein eigener Passkey, die Verpackung des
 * Tresorschluessels fuer ihn - oder nichts.
 *
 * Ohne Verpackung meldet der Passkey zwar an, oeffnet die Daten aber nicht;
 * dann braucht es weiterhin die 24 Woerter.
 */
export type MissingPasskey = "passkey" | "wrap" | null;

/**
 * `ownId` ist der Passkey dieses Browsers, soweit bekannt.
 *
 * Er entscheidet: eine Verpackung an einem anderen Passkey nuetzt hier nichts.
 * Ist die Kennung unbekannt - die Anmeldung lief ueber die 24 Woerter oder eine
 * Kopplung -, bleibt nur der Blick aufs ganze Konto.
 */
export function missingPasskey(
	passkeys: Pick<Passkey, "id" | "hasWrap">[],
	ownId: string | null
): MissingPasskey {
	if (passkeys.length === 0) return "passkey";
	const own = passkeys.find((p) => p.id === ownId);
	if (own) return own.hasWrap ? null : "wrap";
	return passkeys.every((p) => !p.hasWrap) ? "wrap" : null;
}
