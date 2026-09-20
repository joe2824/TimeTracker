// Konto löschen - von Hand (deleteAccount) und automatisch nach Inaktivität
// (deleteInactiveAccounts).
import { beforeEach, describe, expect, it } from "vitest";
import { openDb, type Db } from "./db/index";
import { credentials, devices, sessions, teamMembers, teamReports, teams, users } from "./db/schema";
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

function session(userId: string, expiresInMs: number): void {
	db.insert(sessions)
		.values({ id: `session-${userId}`, userId, createdAt: NOW - YEAR_MS * 2, expiresAt: NOW + expiresInMs })
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

	it("lässt ein Konto mit gültiger Browser-Sitzung in Ruhe, auch ohne Gerät oder Passkey", () => {
		// Ein Chef, der ein Team nur über den Browser führt, koppelt nie ein
		// Gerät und legt nie erneut einen Passkey an - die Sitzung ist dort der
		// einzige Beleg, dass das Konto noch benutzt wird.
		user("frida", YEAR_MS * 2);
		session("frida", 1000);

		expect(deleteInactiveAccounts(db, YEAR_MS, NOW)).toBe(0);
		expect(db.select().from(users).where(eq(users.id, "frida")).get()).toBeDefined();
	});

	it("eine bereits abgelaufene Sitzung zählt nicht als Aktivität", () => {
		user("greta", YEAR_MS * 2);
		session("greta", -1000);

		expect(deleteInactiveAccounts(db, YEAR_MS, NOW)).toBe(1);
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

	function teamWithMember(ownerId: string, lastSeenAgoMs: number | null): void {
		db.insert(teams)
			.values({ id: `team-${ownerId}`, ownerUserId: ownerId, name: "Vertrieb", createdAt: NOW - YEAR_MS * 2 })
			.run();
		db.insert(teamMembers)
			.values({
				id: `member-${ownerId}`,
				teamId: `team-${ownerId}`,
				name: "Anna Meier",
				tokenHash: `team-hash-${ownerId}`,
				createdAt: NOW - YEAR_MS * 2,
				lastSeenAt: lastSeenAgoMs === null ? null : NOW - lastSeenAgoMs
			})
			.run();
	}

	it("lässt einen Chef in Ruhe, dessen Team-Mitglied sich kürzlich gemeldet hat", () => {
		// Mitglieder melden sich über ihren Team-Token, nicht über ein Gerät des
		// Chefs - das Team lebt, auch wenn der Chef selbst nie vorbeischaut.
		user("hanna", YEAR_MS * 2);
		teamWithMember("hanna", YEAR_MS / 2);

		expect(deleteInactiveAccounts(db, YEAR_MS, NOW)).toBe(0);
		expect(db.select().from(teams).where(eq(teams.id, "team-hanna")).get()).toBeDefined();
	});

	it("lässt einen Chef in Ruhe, dessen Team kürzlich einen Bericht bekommen hat", () => {
		user("ida", YEAR_MS * 2);
		teamWithMember("ida", YEAR_MS * 2);
		db.insert(teamReports)
			.values({
				teamId: "team-ida",
				memberId: "member-ida",
				month: "2026-08",
				submittedAt: NOW - YEAR_MS / 2,
				payload: "{}"
			})
			.run();

		expect(deleteInactiveAccounts(db, YEAR_MS, NOW)).toBe(0);
	});

	it("löscht einen Chef, dessen Team ebenfalls seit der Frist ruht", () => {
		user("jonas", YEAR_MS * 2);
		teamWithMember("jonas", YEAR_MS * 2);

		expect(deleteInactiveAccounts(db, YEAR_MS, NOW)).toBe(1);
	});

	it("tut nichts, wenn niemand die Frist überschreitet", () => {
		user("anna", 1000);
		expect(deleteInactiveAccounts(db, YEAR_MS, NOW)).toBe(0);
	});
});
