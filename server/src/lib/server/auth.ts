// Wer darf was - Passkeys, Sitzungen, Geraete-Token.
//
// Zwei Wege fuehren zu einem Konto:
//   - Browser: Passkey -> Sitzungs-Cookie
//   - Desktop: einmalige Kopplung -> langlebiges Geraete-Token
//
// Beide landen bei derselben Frage: welchem Konto gehoert diese Anfrage. Alles
// darunter arbeitet nur noch mit dieser einen Antwort.
import { and, eq, isNull, lt } from "drizzle-orm";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Db } from "./db";
import { challenges, devices, sessions, users } from "./db/schema";
import { CHALLENGE_TTL_MS, SESSION_TTL_MS } from "./config";

/**
 * Geheimnisse werden nur als Hash abgelegt.
 *
 * Wer den Datenbestand in die Haende bekommt, hat damit keine gueltigen Token -
 * derselbe Grund, aus dem niemand Passwoerter im Klartext speichert. SHA-256
 * genuegt hier, anders als bei Passwoertern: die Werte sind 256 Bit Zufall, es
 * gibt nichts zu erraten.
 */
export function hashSecret(secret: string): string {
	return createHash("sha256").update(secret).digest("hex");
}

export function newSecret(): string {
	return randomBytes(32).toString("base64url");
}

/** Vergleich ohne Laufzeitunterschied - sonst laesst sich ein Wert erraten. */
export function safeEqual(a: string, b: string): boolean {
	const x = Buffer.from(a);
	const y = Buffer.from(b);
	return x.length === y.length && timingSafeEqual(x, y);
}

// ---------- WebAuthn-Aufgaben ----------

/**
 * Eine Aufgabe hinterlegen.
 *
 * In der Datenbank statt im Prozessgedaechtnis: damit spaeter eine zweite
 * Instanz danebenlaufen kann, ohne dass Anmeldungen scheitern, die zufaellig auf
 * der anderen begonnen haben.
 */
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

/**
 * Eine Aufgabe einloesen - genau einmal.
 *
 * Das Loeschen ist der Punkt: eine Aufgabe, die zweimal gilt, laesst sich
 * wiederverwenden.
 */
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

export function userFromSession(db: Db, secret: string): string | null {
	const row = db.select().from(sessions).where(eq(sessions.id, hashSecret(secret))).get();
	if (!row) return null;
	if (row.expiresAt < Date.now()) {
		db.delete(sessions).where(eq(sessions.id, row.id)).run();
		return null;
	}
	return row.userId;
}

export function destroySession(db: Db, secret: string): void {
	db.delete(sessions).where(eq(sessions.id, hashSecret(secret))).run();
}

// ---------- Geraete ----------

export interface DeviceAuth {
	userId: string;
	deviceId: string;
}

/**
 * Ein Geraet anlegen und sein Token ausgeben.
 *
 * Das Token wird genau einmal zurueckgegeben - danach steht nur noch sein Hash
 * in der Datenbank und niemand kann es mehr nachlesen, auch der Betreiber nicht.
 */
export function createDevice(db: Db, userId: string, label: string): { id: string; token: string } {
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

/**
 * Ein Geraet widerrufen.
 *
 * Die Zeile bleibt stehen: sie sagt, dass es das Geraet gab und wann es
 * ausgeschlossen wurde. Ohne diese Spur waere ein Widerruf von einem "hat es nie
 * gegeben" nicht zu unterscheiden.
 */
export function revokeDevice(db: Db, userId: string, deviceId: string): boolean {
	const r = db
		.update(devices)
		.set({ revokedAt: Date.now() })
		.where(and(eq(devices.id, deviceId), eq(devices.userId, userId), isNull(devices.revokedAt)))
		.run();
	return r.changes > 0;
}

// ---------- Aufraeumen ----------

/**
 * Abgelaufenes wegraeumen.
 *
 * Laeuft beim Start und danach stuendlich. Ohne das wuechse die
 * Aufgaben-Tabelle mit jedem abgebrochenen Anmeldeversuch weiter - langsam, aber
 * unbegrenzt.
 */
export function cleanupExpired(db: Db): void {
	const jetzt = Date.now();
	db.delete(challenges).where(lt(challenges.expiresAt, jetzt)).run();
	db.delete(sessions).where(lt(sessions.expiresAt, jetzt)).run();
}

/** Ob es das Konto (noch) gibt - nach einem Widerruf oder einer Loeschung. */
export function userExists(db: Db, userId: string): boolean {
	return db.select().from(users).where(eq(users.id, userId)).get() !== undefined;
}

