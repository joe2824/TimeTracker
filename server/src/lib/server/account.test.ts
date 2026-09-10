// Konto löschen - von Hand (deleteAccount) und automatisch nach Inaktivität
// (deleteInactiveAccounts).
import { beforeEach, describe, expect, it } from "vitest";
import { openDb, type Db } from "./db/index";
import { credentials, devices, teams, users } from "./db/schema";
import { deleteInactiveAccounts } from "./account";
import { eq } from "drizzle-orm";

let db: Db;

const YEAR_MS = 365 * 24 * 3600_000;
const NOW = Date.now();

function user(id: string, createdAgoMs: number): void {
	db.insert(users).values({ id, displayName: id, createdAt: NOW - createdAgoMs, seqCounter: 0 }).run();
}

function device(userId: string, lastSeenAgoMs: number): void {
	db.insert(devices)
		.values({
			id: `device-${userId}`,
			userId,
			label: "Rechner",
			tokenHash: `hash-${userId}`,
			createdAt: NOW - YEAR_MS * 2,
			lastSeenAt: NOW - lastSeenAgoMs
		})
		.run();
}

function credential(userId: string, lastUsedAgoMs: number): void {
	db.insert(credentials)
		.values({
			id: `cred-${userId}`,
			userId,
			publicKey: Buffer.from("key"),
			createdAt: NOW - YEAR_MS * 2,
			lastUsedAt: NOW - lastUsedAgoMs
		})
		.run();
}

beforeEach(() => {
	db = openDb(":memory:").db;
});

describe("deleteInactiveAccounts", () => {
	it("löscht ein Konto ohne jede Aktivität seit der Frist", () => {
		user("anna", YEAR_MS * 2);

		const n = deleteInactiveAccounts(db, YEAR_MS, NOW);

		expect(n).toBe(1);
		expect(db.select().from(users).where(eq(users.id, "anna")).get()).toBeUndefined();
	});

	it("lässt ein Konto mit einem kürzlich benutzten Gerät in Ruhe", () => {
		user("bodo", YEAR_MS * 2);
		device("bodo", YEAR_MS / 2);

		expect(deleteInactiveAccounts(db, YEAR_MS, NOW)).toBe(0);
		expect(db.select().from(users).where(eq(users.id, "bodo")).get()).toBeDefined();
	});

	it("lässt ein Konto mit einem kürzlich benutzten Passkey in Ruhe", () => {
		user("clara", YEAR_MS * 2);
		credential("clara", YEAR_MS / 2);

		expect(deleteInactiveAccounts(db, YEAR_MS, NOW)).toBe(0);
		expect(db.select().from(users).where(eq(users.id, "clara")).get()).toBeDefined();
	});

	it("lässt ein frisch angelegtes Konto in Ruhe, auch ohne Gerät oder Passkey", () => {
		// Ein abgebrochenes Anlegen (z.B. Registrierung ohne fertigen Passkey)
		// soll nicht schon in der ersten Stunde als "seit je inaktiv" gelten.
		user("dirk", 60_000);

		expect(deleteInactiveAccounts(db, YEAR_MS, NOW)).toBe(0);
		expect(db.select().from(users).where(eq(users.id, "dirk")).get()).toBeDefined();
	});

	it("ein Gerät, das selbst laenger als die Frist nicht mehr gesehen wurde, zaehlt nicht als Aktivitaet", () => {
		user("erik", YEAR_MS * 2);
		device("erik", YEAR_MS * 2);

		expect(deleteInactiveAccounts(db, YEAR_MS, NOW)).toBe(1);
	});

	it("räumt beim Löschen auch abhängige Daten weg (Fremdschlüssel-Kaskade), z.B. ein Team", () => {
		user("anna", YEAR_MS * 2);
		db.insert(teams).values({ id: "team-1", ownerUserId: "anna", name: "Vertrieb", createdAt: NOW }).run();

		deleteInactiveAccounts(db, YEAR_MS, NOW);

		expect(db.select().from(teams).where(eq(teams.id, "team-1")).get()).toBeUndefined();
	});

	it("tut nichts, wenn niemand die Frist überschreitet", () => {
		user("anna", 1000);
		expect(deleteInactiveAccounts(db, YEAR_MS, NOW)).toBe(0);
	});
});
