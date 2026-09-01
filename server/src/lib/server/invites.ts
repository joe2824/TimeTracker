// Einladungen: ausstellen, pruefen, entwerten.
import { and, desc, eq, isNull } from "drizzle-orm";
import type { Db, DbLike } from "./db";
import { invites, serverSettings, users } from "./db/schema";
import { INVITE_CODES, REGISTRATION_OPEN } from "./config";
import { randomInt } from "node:crypto";
import { safeEqual } from "./auth";

/** Das Alphabet fuer ausgestellte Codes. */
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/** Ein neuer Code: vier Gruppen zu vier Zeichen. */
export function newCode(): string {
	const group = () =>
		Array.from({ length: 4 }, () => ALPHABET[randomInt(ALPHABET.length)]).join("");
	return [group(), group(), group(), group()].join("-");
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
export function createInvite(
	db: DbLike,
	from: string,
	opts: { note?: string; expiresAt?: number | null } = {}
): InviteRow {
	const rowText = {
		code: newCode(),
		createdAt: Date.now(),
		createdBy: from,
		note: opts.note?.slice(0, 200) || null,
		expiresAt: opts.expiresAt ?? null,
		usedAt: null,
		usedBy: null,
		revokedAt: null
	};
	db.insert(invites).values(rowText).run();
	return rowText;
}

/** Alle Einladungen, neueste zuerst. */
export function listInvites(db: Db): InviteRow[] {
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
export function revokeInvite(db: Db, code: string): boolean {
	const r = db
		.update(invites)
		.set({ revokedAt: Date.now() })
		.where(and(eq(invites.code, code), isNull(invites.usedAt), isNull(invites.revokedAt)))
		.run();
	return r.changes > 0;
}

/** Ob offene Registrierung (ohne Einladungscode) aktiv ist. */
export function isRegistrationOpen(db: DbLike): boolean {
	const rowText = db
		.select()
		.from(serverSettings)
		.where(eq(serverSettings.key, "open_registration"))
		.get();
	if (rowText) return rowText.value === "true";
	return REGISTRATION_OPEN;
}

/** Offene Registrierung zur Laufzeit aktivieren oder deaktivieren. */
export function setRegistrationOpen(db: DbLike, open: boolean): void {
	const val = open ? "true" : "false";
	const nowMs = Date.now();
	db.insert(serverSettings)
		.values({ key: "open_registration", value: val, updatedAt: nowMs })
		.onConflictDoUpdate({
			target: serverSettings.key,
			set: { value: val, updatedAt: nowMs }
		})
		.run();
}

/** Ob statische Einladungscodes aus INVITE_CODES per Servereinstellung deaktiviert wurden. */
export function envInvitesDisabled(db: DbLike): boolean {
	const rowText = db
		.select()
		.from(serverSettings)
		.where(eq(serverSettings.key, "env_invites_disabled"))
		.get();
	return rowText?.value === "true";
}

/** Statische Einladungscodes zur Laufzeit aktivieren oder deaktivieren. */
export function setEnvInvitesDisabled(db: DbLike, disabled: boolean): void {
	const val = disabled ? "true" : "false";
	const nowMs = Date.now();
	db.insert(serverSettings)
		.values({ key: "env_invites_disabled", value: val, updatedAt: nowMs })
		.onConflictDoUpdate({
			target: serverSettings.key,
			set: { value: val, updatedAt: nowMs }
		})
		.run();
}

/** Gilt dieser Code? */
export function validCode(db: DbLike, code: string): boolean {
	if (isRegistrationOpen(db)) return true;
	if (!code) return false;
	// Die Tuerklinke aus der Umgebung (sofern nicht zur Laufzeit deaktiviert).
	if (!envInvitesDisabled(db) && INVITE_CODES.some((c) => safeEqual(c, code))) return true;

	const rowText = db.select().from(invites).where(eq(invites.code, code)).get();
	if (!rowText) return false;
	if (rowText.usedAt || rowText.revokedAt) return false;
	if (rowText.expiresAt && rowText.expiresAt < Date.now()) return false;
	return true;
}

/** Beim Anlegen des Kontos: den Code entwerten, sofern er aus der Tabelle kam. */
export function consumeCode(db: DbLike, code: string, userId: string): void {
	db.update(invites)
		.set({ usedAt: Date.now(), usedBy: userId })
		.where(and(eq(invites.code, code), isNull(invites.usedAt)))
		.run();
}

/** Ist dieses Konto ein Verwalter? */
export function isAdminUser(db: DbLike, userId: string): boolean {
	return db.select().from(users).where(eq(users.id, userId)).get()?.isAdmin === true;
}
