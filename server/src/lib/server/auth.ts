// Wer darf was - Passkeys, Sitzungen, Geräte-Token.
//
// Zwei Wege führen zu einem Konto:
//   - Browser: Passkey -> Sitzungs-Cookie
//   - Desktop: einmalige Kopplung -> langlebiges Geräte-Token
import { and, eq, isNull, lt } from "drizzle-orm";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { Db, DbLike } from "./db/index";
import { challenges, devices, pairings, sessions, users } from "./db/schema";
import { CHALLENGE_TTL_MS, HMAC_SECRET, SESSION_REFRESH_MS, SESSION_TTL_MS } from "./config";

/** Geheimnisse werden nur als Hash abgelegt.
 *  Mit HMAC_SECRET: sicher gegen DB-Exfil (serverseitiger Schlüssel nötig).
 *  Ohne HMAC_SECRET: Fallback auf SHA-256 (bisheriges Verhalten, keine Regression). */
export function hashSecret(secret: string): string {
	if (HMAC_SECRET) {
		return createHmac("sha256", HMAC_SECRET).update(secret).digest("hex");
	}
	return createHash("sha256").update(secret).digest("hex");
}

/** Reiner SHA-256 Hex-Hash (ohne HMAC) für clientseitig gerechnete Hashes wie claimHash. */
export function sha256Hex(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

export function newSecret(): string {
	return randomBytes(32).toString("base64url");
}

/** Vergleich ohne Laufzeitunterschied - sonst lässt sich ein Wert erraten. */
export function safeEqual(a: string, b: string): boolean {
	const x = Buffer.from(a);
	const y = Buffer.from(b);
	return x.length === y.length && timingSafeEqual(x, y);
}

// ---------- WebAuthn-Aufgaben ----------

/** Eine Aufgabe hinterlegen. */
export function storeChallenge(
	db: Db,
	challenge: string,
	purpose: "register" | "login" | "delete" | "addkey",
	userId: string | null
): string {
	const id = newSecret();
	db.insert(challenges)
		.values({ id, challenge, purpose, userId, expiresAt: Date.now() + CHALLENGE_TTL_MS })
		.run();
	return id;
}

/** Eine Aufgabe einlösen - genau einmal. */
export function takeChallenge(
	db: Db,
	id: string,
	purpose: "register" | "login" | "delete" | "addkey"
): { challenge: string; userId: string | null } | null {
	const row = db.select().from(challenges).where(eq(challenges.id, id)).get();
	db.delete(challenges).where(eq(challenges.id, id)).run();
	if (!row || row.purpose !== purpose || row.expiresAt < Date.now()) return null;
	return { challenge: row.challenge, userId: row.userId };
}

// ---------- Sitzungen ----------

export function createSession(db: Db, userId: string): string {
	const secret = newSecret();
	db.insert(sessions)
		.values({
			id: hashSecret(secret),
			userId,
			createdAt: Date.now(),
			expiresAt: Date.now() + SESSION_TTL_MS
		})
		.run();
	return secret;
}

export interface SessionAuth {
	userId: string;
	/** Ob die Frist dabei verlängert wurde - dann muss das Cookie nachziehen. */
	slid: boolean;
}

export function userFromSession(db: Db, secret: string): SessionAuth | null {
	const row = db.select().from(sessions).where(eq(sessions.id, hashSecret(secret))).get();
	if (!row) return null;
	const now = Date.now();
	if (row.expiresAt < now) {
		db.delete(sessions).where(eq(sessions.id, row.id)).run();
		return null;
	}

	// Wer die Anwendung benutzt, wird nicht abgemeldet. Die Frist läuft ab der
	// letzten Nutzung, und `expiresAt - SESSION_TTL_MS` ist der Zeitpunkt, an dem
	// sie zuletzt gesetzt wurde.
	const touched = row.expiresAt - SESSION_TTL_MS;
	if (now - touched < SESSION_REFRESH_MS) return { userId: row.userId, slid: false };

	db.update(sessions)
		.set({ expiresAt: now + SESSION_TTL_MS })
		.where(eq(sessions.id, row.id))
		.run();
	return { userId: row.userId, slid: true };
}

export function destroySession(db: Db, secret: string): void {
	db.delete(sessions).where(eq(sessions.id, hashSecret(secret))).run();
}

// ---------- Geräte ----------

export interface DeviceAuth {
	userId: string;
	deviceId: string;
}

/** Ein Gerät anlegen und sein Token ausgeben. */
export function createDevice(
	db: DbLike,
	userId: string,
	label: string
): { id: string; token: string } {
	const id = crypto.randomUUID();
	const token = newSecret();
	db.insert(devices)
		.values({ id, userId, label, tokenHash: hashSecret(token), createdAt: Date.now() })
		.run();
	return { id, token };
}

export function deviceFromToken(db: Db, token: string): DeviceAuth | null {
	const row = db.select().from(devices).where(eq(devices.tokenHash, hashSecret(token))).get();
	if (!row || row.revokedAt) return null;
	db.update(devices).set({ lastSeenAt: Date.now() }).where(eq(devices.id, row.id)).run();
	return { userId: row.userId, deviceId: row.id };
}

/** Ein Gerät widerrufen. */
export function revokeDevice(db: Db, userId: string, deviceId: string): boolean {
	const r = db
		.update(devices)
		.set({ revokedAt: Date.now() })
		.where(and(eq(devices.id, deviceId), eq(devices.userId, userId), isNull(devices.revokedAt)))
		.run();
	return r.changes > 0;
}

// ---------- Aufräumen ----------

/** Abgelaufenes wegräumen. */
export function cleanupExpired(db: Db): void {
	const nowMs = Date.now();
	db.delete(challenges).where(lt(challenges.expiresAt, nowMs)).run();
	db.delete(sessions).where(lt(sessions.expiresAt, nowMs)).run();

	// Abgelaufene Kopplungen. Wer abholt, löscht seine Zeile dabei selbst (siehe
	// /api/pair/claim) - was hier abgelaufen liegen bleibt, wurde also nie
	// abgeholt. Steht darin trotzdem ein Token, hat jemand bestätigt und das
	// neue Gerät ist nie erschienen. Dann gehört dieses Gerät widerrufen: das
	// Token ist gültig, aber niemand hatte es je in den Händen, und es stünde
	// sonst bis zur Handarbeit in der Geräteliste seines Kontos.
	const stale = db.select().from(pairings).where(lt(pairings.expiresAt, nowMs)).all();
	for (const p of stale) {
		if (!p.deviceToken) continue;
		db.update(devices)
			.set({ revokedAt: nowMs })
			.where(and(eq(devices.tokenHash, hashSecret(p.deviceToken)), isNull(devices.revokedAt)))
			.run();
	}
	db.delete(pairings).where(lt(pairings.expiresAt, nowMs)).run();
}

/** Ob es das Konto (noch) gibt - nach einem Widerruf oder einer Löschung. */
export function userExists(db: Db, userId: string): boolean {
	return db.select().from(users).where(eq(users.id, userId)).get() !== undefined;
}

