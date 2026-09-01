// Invite management: creation, validation, consumption, and admin role checking.
import { and, desc, eq, isNull } from "drizzle-orm";
import type { Db, DbLike } from "./db";
import { invites, serverSettings, users } from "./db/schema";
import { INVITE_CODES, REGISTRATION_OPEN } from "./config";
import { randomInt } from "node:crypto";
import { safeEqual } from "./auth";

/** Character set for generated invite codes. */
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/** Generate a new formatted invite code: 4 groups of 4 characters. */
export function generateInviteCode(): string {
	const group = () =>
		Array.from({ length: 4 }, () => ALPHABET[randomInt(ALPHABET.length)]).join("");
	return [group(), group(), group(), group()].join("-");
}

export const newCode = generateInviteCode;

export interface InviteRow {
	code: string;
	createdAt: number;
	note: string | null;
	expiresAt: number | null;
	usedAt: number | null;
	usedBy: string | null;
	revokedAt: number | null;
}

/** Create a new invite code record. */
export function createInvite(
	db: DbLike,
	createdBy: string,
	opts: { note?: string; expiresAt?: number | null } = {}
): InviteRow {
	const row = {
		code: generateInviteCode(),
		createdAt: Date.now(),
		createdBy,
		note: opts.note?.slice(0, 200) || null,
		expiresAt: opts.expiresAt ?? null,
		usedAt: null,
		usedBy: null,
		revokedAt: null
	};
	db.insert(invites).values(row).run();
	return row;
}

/** List all invite codes, newest first. */
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

/** Revoke an existing invite code. */
export function revokeInvite(db: Db, code: string): boolean {
	const res = db
		.update(invites)
		.set({ revokedAt: Date.now() })
		.where(and(eq(invites.code, code), isNull(invites.usedAt), isNull(invites.revokedAt)))
		.run();
	return res.changes > 0;
}

/** Check if open registration (without invite code) is enabled. */
export function isRegistrationOpen(db: DbLike): boolean {
	const row = db
		.select()
		.from(serverSettings)
		.where(eq(serverSettings.key, "open_registration"))
		.get();
	if (row) return row.value === "true";
	return REGISTRATION_OPEN;
}

/** Toggle open registration setting at runtime. */
export function setRegistrationOpen(db: DbLike, open: boolean): void {
	const val = open ? "true" : "false";
	const now = Date.now();
	db.insert(serverSettings)
		.values({ key: "open_registration", value: val, updatedAt: now })
		.onConflictDoUpdate({
			target: serverSettings.key,
			set: { value: val, updatedAt: now }
		})
		.run();
}

/** Check if static invite codes from INVITE_CODES (.env) are disabled. */
export function isEnvInvitesDisabled(db: DbLike): boolean {
	const row = db
		.select()
		.from(serverSettings)
		.where(eq(serverSettings.key, "env_invites_disabled"))
		.get();
	return row?.value === "true";
}

export const envInvitesDisabled = isEnvInvitesDisabled;

/** Toggle static .env invite codes at runtime. */
export function setEnvInvitesDisabled(db: DbLike, disabled: boolean): void {
	const val = disabled ? "true" : "false";
	const now = Date.now();
	db.insert(serverSettings)
		.values({ key: "env_invites_disabled", value: val, updatedAt: now })
		.onConflictDoUpdate({
			target: serverSettings.key,
			set: { value: val, updatedAt: now }
		})
		.run();
}

/** Validate whether an invite code is currently valid. */
export function isValidInviteCode(db: DbLike, code: string): boolean {
	if (isRegistrationOpen(db)) return true;
	if (!code) return false;
	if (!isEnvInvitesDisabled(db) && INVITE_CODES.some((c) => safeEqual(c, code))) return true;

	const row = db.select().from(invites).where(eq(invites.code, code)).get();
	if (!row) return false;
	if (row.usedAt || row.revokedAt) return false;
	if (row.expiresAt && row.expiresAt < Date.now()) return false;
	return true;
}

export const validCode = isValidInviteCode;

/** Mark an invite code as consumed by a registered user. */
export function consumeInviteCode(db: DbLike, code: string, userId: string): void {
	db.update(invites)
		.set({ usedAt: Date.now(), usedBy: userId })
		.where(and(eq(invites.code, code), isNull(invites.usedAt)))
		.run();
}

export const consumeCode = consumeInviteCode;

/** Check if a given user has the admin role. */
export function isAdminUser(db: DbLike, userId: string): boolean {
	return db.select().from(users).where(eq(users.id, userId)).get()?.isAdmin === true;
}

// ---------- Backward Compatibility Aliases ----------
export const neuerCode = generateInviteCode;
export const erstelleInvite = createInvite;
export const listeInvites = listInvites;
export const zieheInviteZurueck = revokeInvite;
export const istRegistrierungOffen = isRegistrationOpen;
export const setzeRegistrierungOffen = setRegistrationOpen;
export const envInvitesDeaktiviert = isEnvInvitesDisabled;
export const setzeEnvInvitesDeaktiviert = setEnvInvitesDisabled;
export const gueltigerCode = isValidInviteCode;
export const entwerteCode = consumeInviteCode;
export const istVerwalter = isAdminUser;


