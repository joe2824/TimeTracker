// Die Passkeys eines Kontos, wie die Oberflaeche sie braucht.
//
// Steht hier einmal, weil zwei Routen sie liefern (/api/passkeys und /api/me).
// Zwei Fassungen liefen auseinander: /me gab weder Namen noch Verpackung
// heraus, und die Verwaltung zeigte daraufhin jeden Passkey als unbenannt und
// unverschluesselt an - auch die, die beides hatten.
import { and, eq } from "drizzle-orm";
import type { DbLike } from "./db";
import { credentials, keyWraps } from "./db/schema";

export interface PasskeyView {
	id: string;
	label: string | null;
	/** Was der Authentifikator koennte. */
	hasPrf: boolean;
	/** Ob er es auch tut - daran haengt, ob er die Daten allein oeffnet. */
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

	return db
		.select()
		.from(credentials)
		.where(eq(credentials.userId, userId))
		.all()
		.map((c) => ({
			id: c.id,
			label: c.label,
			hasPrf: c.hasPrf,
			hasWrap: wrapped.has(c.id),
			createdAt: c.createdAt,
			lastUsedAt: c.lastUsedAt
		}));
}
