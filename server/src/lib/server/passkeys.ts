// Die Passkeys eines Kontos, wie die Oberfläche sie braucht.
//
// Steht hier einmal, weil zwei Routen sie liefern (/api/passkeys und /api/me).
// Zwei Fassungen liefen auseinander: /me gab weder Namen noch Verpackung
// heraus, und die Verwaltung zeigte daraufhin jeden Passkey als unbenannt und
// unverschlüsselt an - auch die, die beides hatten.
import { and, eq } from "drizzle-orm";
import type { DbLike } from "./db/index";
import { keyWraps } from "./db/schema";
import { listCredentials } from "./webauthn";

export interface PasskeyView {
	id: string;
	label: string | null;
	/** Ob der Vault-Schlüssel für ihn verpackt vorliegt - dann öffnet er die Daten allein. */
	hasWrap: boolean;
	createdAt: number;
	lastUsedAt: number | null;
}

export function listPasskeys(db: DbLike, userId: string): PasskeyView[] {
	const wrapped = new Set(
		db
			.select()
			.from(keyWraps)
			.where(and(eq(keyWraps.userId, userId), eq(keyWraps.kind, "passkey")))
			.all()
			.map((w) => w.credentialId)
	);

	return listCredentials(db, userId).map((c) => ({
		id: c.id,
		label: c.label,
		hasWrap: wrapped.has(c.id),
		createdAt: c.createdAt,
		lastUsedAt: c.lastUsedAt
	}));
}
