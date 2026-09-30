// Invite management: creation, validation, consumption, and admin role checking.
import { and, desc, eq, gt, inArray, isNull, or } from "drizzle-orm";
import type { Db, DbLike } from "./db/index";
import { invites, serverSettings, users } from "./db/schema";
import { INVITE_CODES, REGISTRATION_OPEN } from "./config";
import { randomInt } from "node:crypto";
import { safeEqual } from "./auth";
import {
	CODE_ALPHABET,
	INVITE_CODE_GROUP_LENGTH,
	INVITE_CODE_GROUPS,
	isInviteCode,
	normalizeInviteCode
} from "$shared/codes";

/** Generate a new formatted invite code: 4 groups of 4 characters. */
export function generateInviteCode(): string {
	const group = () =>
		Array.from({ length: INVITE_CODE_GROUP_LENGTH }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join("");
	return Array.from({ length: INVITE_CODE_GROUPS }, group).join("-");
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

type SettingKey = "open_registration" | "env_invites_disabled";

function getSetting(db: DbLike, key: SettingKey): string | undefined {
	return db.select().from(serverSettings).where(eq(serverSettings.key, key)).get()?.value;
}

function setSetting(db: DbLike, key: SettingKey, value: string): void {
	const now = Date.now();
	db.insert(serverSettings)
		.values({ key, value, updatedAt: now })
		.onConflictDoUpdate({ target: serverSettings.key, set: { value, updatedAt: now } })
		.run();
}

/** Check if open registration (without invite code) is enabled. */
export function isRegistrationOpen(db: DbLike): boolean {
	const value = getSetting(db, "open_registration");
	return value === undefined ? REGISTRATION_OPEN : value === "true";
}

/** Toggle open registration setting at runtime. */
export function setRegistrationOpen(db: DbLike, open: boolean): void {
	setSetting(db, "open_registration", open ? "true" : "false");
}

/** Check if static invite codes from INVITE_CODES (.env) are disabled. */
export function isEnvInvitesDisabled(db: DbLike): boolean {
	return getSetting(db, "env_invites_disabled") === "true";
}

/** Toggle static .env invite codes at runtime. */
export function setEnvInvitesDisabled(db: DbLike, disabled: boolean): void {
	setSetting(db, "env_invites_disabled", disabled ? "true" : "false");
}

/**
 * Ob der Code einer der statischen aus INVITE_CODES ist. Die dürfen beliebig
 * aussehen - verziehen wird (Grossschreibung, Striche) nur bei denen, die die
 * Form eines erzeugten Codes haben.
 */
function isEnvInviteCode(db: DbLike, code: string): boolean {
	if (!code || isEnvInvitesDisabled(db)) return false;
	const normalized = normalizeInviteCode(code);
	return INVITE_CODES.some((c) => {
		if (safeEqual(c, code)) return true;
		return hasInviteCodeShape(c) && safeEqual(normalizeInviteCode(c), normalized);
	});
}

/**
 * Ob ein statischer Code bis auf Schreibweise ein erzeugter ist. Nur Striche
 * und Leerzeichen dürfen wegfallen - sonst passte "ABCD-EFGH-JKLM-NPQR-0" auch
 * ohne die "0".
 */
function hasInviteCodeShape(c: string): boolean {
	const shaped = normalizeInviteCode(c);
	return isInviteCode(shaped) && shaped.replaceAll("-", "") === c.toUpperCase().replace(/[\s-]/g, "");
}

/**
 * Wie ein Code in der Tabelle stehen kann: so wie getippt, oder - bei einem
 * erzeugten Code - in seiner verziehenen Form. Die wörtliche Form bleibt drin,
 * damit Codes, die nicht aus generateInviteCode stammen, weiter gelten.
 */
export function inviteCodeCandidates(code: string): string[] {
	const raw = code.trim();
	const normalized = normalizeInviteCode(raw);
	return isInviteCode(normalized) && normalized !== raw ? [raw, normalized] : [raw];
}

/** Ein Tabellen-Code, der weder benutzt, zurückgezogen noch abgelaufen ist. */
function usableInvite(code: string, now: number) {
	return and(
		inArray(invites.code, inviteCodeCandidates(code)),
		isNull(invites.usedAt),
		isNull(invites.revokedAt),
		or(isNull(invites.expiresAt), gt(invites.expiresAt, now))
	);
}

/** Validate whether an invite code is currently valid. */
export function isValidInviteCode(db: DbLike, code: string): boolean {
	if (isRegistrationOpen(db)) return true;
	if (!code) return false;
	if (isEnvInviteCode(db, code)) return true;
	return db.select().from(invites).where(usableInvite(code, Date.now())).get() !== undefined;
}

/**
 * Den Code beim Anlegen des Kontos entwerten - false, wenn er (inzwischen)
 * nicht mehr gilt. Die Prüfung sitzt in derselben Anweisung wie das
 * Entwerten: zwischen einer früheren Prüfung und hier kann ein zweiter
 * Aufruf denselben Code verbraucht oder ein Verwalter ihn zurückgezogen haben.
 * Statische Codes aus INVITE_CODES gelten mehrfach und werden nicht entwertet.
 */
export function consumeInviteCode(db: DbLike, code: string, userId: string): boolean {
	if (isRegistrationOpen(db)) return true;
	if (isEnvInviteCode(db, code)) return true;
	const now = Date.now();
	const res = db
		.update(invites)
		.set({ usedAt: now, usedBy: userId })
		.where(usableInvite(code, now))
		.run();
	return res.changes > 0;
}

/** Check if a given user has the admin role. */
export function isAdminUser(db: DbLike, userId: string): boolean {
	return db.select().from(users).where(eq(users.id, userId)).get()?.isAdmin === true;
}
