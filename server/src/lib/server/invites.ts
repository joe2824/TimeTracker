// Einladungen: ausstellen, pruefen, entwerten.
import { and, desc, eq, isNull } from "drizzle-orm";
import type { Db, DbLike } from "./db";
import { invites, users } from "./db/schema";
import { INVITE_CODES } from "./config";
import { randomInt } from "node:crypto";

/** Das Alphabet fuer ausgestellte Codes. */
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/** Ein neuer Code: vier Gruppen zu vier Zeichen. */
export function neuerCode(): string {
	const gruppe = () =>
		Array.from({ length: 4 }, () => ALPHABET[randomInt(ALPHABET.length)]).join("");
	return [gruppe(), gruppe(), gruppe(), gruppe()].join("-");
}

export interface InviteRow {
	code: string;
	createdAt: number;
	note: string | null;
	expiresAt: number | null;
	usedAt: number | null;
	usedBy: string | null;
	revokedAt: number | null;
}

/** Ausstellen. Der Code wird hier erzeugt, nicht vom Aufrufer bestimmt. */
export function erstelleInvite(
	db: DbLike,
	von: string,
	opts: { note?: string; expiresAt?: number | null } = {}
): InviteRow {
	const zeile = {
		code: neuerCode(),
		createdAt: Date.now(),
		createdBy: von,
		note: opts.note?.slice(0, 200) || null,
		expiresAt: opts.expiresAt ?? null,
		usedAt: null,
		usedBy: null,
		revokedAt: null
	};
	db.insert(invites).values(zeile).run();
	return zeile;
}

/** Alle Einladungen, neueste zuerst. */
export function listeInvites(db: Db): InviteRow[] {
	return db
		.select()
		.from(invites)
		.orderBy(desc(invites.createdAt))
		.all()
		.map((i) => ({
			code: i.code,
			createdAt: i.createdAt,
			note: i.note,
			expiresAt: i.expiresAt,
			usedAt: i.usedAt,
			usedBy: i.usedBy,
			revokedAt: i.revokedAt
		}));
}

/** Zurueckziehen. */
export function zieheInviteZurueck(db: Db, code: string): boolean {
	const r = db
		.update(invites)
		.set({ revokedAt: Date.now() })
		.where(and(eq(invites.code, code), isNull(invites.usedAt), isNull(invites.revokedAt)))
		.run();
	return r.changes > 0;
}

/** Gilt dieser Code? */
export function gueltigerCode(db: DbLike, code: string): boolean {
	if (!code) return false;
	// Die Tuerklinke aus der Umgebung.
	if (INVITE_CODES.includes(code)) return true;

	const zeile = db.select().from(invites).where(eq(invites.code, code)).get();
	if (!zeile) return false;
	if (zeile.usedAt || zeile.revokedAt) return false;
	if (zeile.expiresAt && zeile.expiresAt < Date.now()) return false;
	return true;
}

/** Beim Anlegen des Kontos: den Code entwerten, sofern er aus der Tabelle kam. */
export function entwerteCode(db: DbLike, code: string, userId: string): void {
	db.update(invites)
		.set({ usedAt: Date.now(), usedBy: userId })
		.where(and(eq(invites.code, code), isNull(invites.usedAt)))
		.run();
}

/** Ist dieses Konto ein Verwalter? */
export function istVerwalter(db: DbLike, userId: string): boolean {
	return db.select().from(users).where(eq(users.id, userId)).get()?.isAdmin === true;
}
