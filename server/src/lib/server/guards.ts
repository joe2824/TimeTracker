// Wer eine Route aufrufen darf - die Prüfungen, die fast jede Route braucht.
import { error } from "@sveltejs/kit";
import { eq } from "drizzle-orm";
import type { DbLike } from "./db/index";
import { users } from "./db/schema";
import { isAdminUser } from "./invites";

type UserRow = typeof users.$inferSelect;

/** Angemeldet sein - wirft 401 sonst. Liefert die Kennung des Kontos. */
export function requireUser(locals: { userId: string | null }): string {
	if (!locals.userId) error(401, "Nicht angemeldet");
	return locals.userId;
}

/** Angemeldet sein UND das Konto muss noch bestehen - nach einer Löschung zählt die Sitzung nicht mehr. */
export function requireUserRow(locals: { userId: string | null; db: DbLike }): UserRow {
	const userId = requireUser(locals);
	const user = locals.db.select().from(users).where(eq(users.id, userId)).get();
	if (!user) error(401, "Nicht angemeldet");
	return user;
}

/** Server-Verwalter sein - frisch aus der Datenbank geprüft, nicht aus einem Token geglaubt. */
export function requireAdmin(locals: { userId: string | null; db: DbLike }): string {
	const userId = requireUser(locals);
	if (!isAdminUser(locals.db, userId)) error(403, "Keine Berechtigung");
	return userId;
}
