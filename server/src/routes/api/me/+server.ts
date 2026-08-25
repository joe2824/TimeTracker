// Wer bin ich - und was weiss der Server ueber meine Zugaenge.
import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { credentials, devices, keyWraps, users } from "$lib/server/db/schema";
import { eq } from "drizzle-orm";
import { currentSeq } from "$lib/server/sync";

export const GET: RequestHandler = ({ locals }) => {
	if (!locals.userId) error(401, "Nicht angemeldet");
	const user = locals.db.select().from(users).where(eq(users.id, locals.userId)).get();
	if (!user) error(401, "Nicht angemeldet");

	return json({
		userId: user.id,
		displayName: user.displayName,
		email: user.email,
		seq: currentSeq(locals.db, user.id),
		// Nur die Art der Verpackungen, nie ihr Inhalt - der geht ueber /api/wraps
		// und ist auch dort undurchsichtig.
		wrapKinds: locals.db
			.select()
			.from(keyWraps)
			.where(eq(keyWraps.userId, user.id))
			.all()
			.map((w) => w.kind),
		passkeys: locals.db
			.select()
			.from(credentials)
			.where(eq(credentials.userId, user.id))
			.all()
			.map((c) => ({ id: c.id, hasPrf: c.hasPrf, createdAt: c.createdAt, lastUsedAt: c.lastUsedAt })),
		devices: locals.db
			.select()
			.from(devices)
			.where(eq(devices.userId, user.id))
			.all()
			.map((d) => ({ id: d.id, label: d.label, lastSeenAt: d.lastSeenAt, revokedAt: d.revokedAt }))
	});
};
