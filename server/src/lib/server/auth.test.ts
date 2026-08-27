import { beforeEach, describe, expect, it } from "vitest";
import { openDb, type Db } from "./db";
import { devices, pairings, users } from "./db/schema";
import { cleanupExpired, createDevice, deviceFromToken } from "./auth";
import { eq } from "drizzle-orm";

let db: Db;

const ANNA = "user-anna";

/** Eine Kopplung, wie sie /api/pair/start hinterlaesst - Zeitpunkt frei waehlbar. */
function kopplung(code: string, abgelaufen: boolean, deviceToken?: string) {
	const jetzt = Date.now();
	db.insert(pairings)
		.values({
			code,
			userId: deviceToken ? ANNA : null,
			publicKey: "cHVibGljLWtleQ==",
			label: "Rechner",
			wrappedKey: deviceToken ? "cGFrZXQ=" : null,
			deviceToken: deviceToken ?? null,
			createdAt: jetzt - 60_000,
			expiresAt: abgelaufen ? jetzt - 1000 : jetzt + 600_000
		})
		.run();
}

const codes = () =>
	db
		.select()
		.from(pairings)
		.all()
		.map((p) => p.code);

beforeEach(() => {
	db = openDb(":memory:").db;
	db.insert(users).values({ id: ANNA, displayName: "Anna", createdAt: 1, seqCounter: 0 }).run();
});

describe("cleanupExpired: Kopplungen", () => {
	it("raeumt eine abgelaufene, nie bestaetigte Kopplung weg", () => {
		kopplung("ABCDEFGHJKLM", true);
		cleanupExpired(db);
		expect(codes()).toEqual([]);
	});

	it("laesst eine laufende Kopplung in Ruhe", () => {
		kopplung("ABCDEFGHJKLM", false);
		cleanupExpired(db);
		expect(codes()).toEqual(["ABCDEFGHJKLM"]);
	});

	it("widerruft das Geraet einer bestaetigten, nie abgeholten Kopplung", () => {
		// Der gefaehrliche Fall: jemand hat bestaetigt, das neue Geraet ist nie
		// erschienen. Das Token gilt, aber niemand hatte es je in der Hand - es
		// laege sonst im Klartext in der Zeile und zaehlte weiter als Geraet.
		const geraet = createDevice(db, ANNA, "Rechner");
		kopplung("ABCDEFGHJKLM", true, geraet.token);

		expect(deviceFromToken(db, geraet.token)).not.toBeNull();
		cleanupExpired(db);

		expect(codes()).toEqual([]);
		expect(deviceFromToken(db, geraet.token)).toBeNull();
		expect(db.select().from(devices).where(eq(devices.id, geraet.id)).get()?.revokedAt).toBeTypeOf(
			"number"
		);
	});

	it("laesst ein abgeholtes Geraet in Ruhe", () => {
		// Wer abholt, loescht seine Kopplungszeile dabei selbst. Es darf nicht
		// passieren, dass das Aufraeumen ein Geraet trifft, das laengst laeuft.
		const geraet = createDevice(db, ANNA, "Rechner");
		cleanupExpired(db);
		expect(deviceFromToken(db, geraet.token)).toEqual({ userId: ANNA, deviceId: geraet.id });
	});

	it("ruehrt ein Geraet nicht an, das zu einer laufenden Kopplung gehoert", () => {
		const geraet = createDevice(db, ANNA, "Rechner");
		kopplung("ABCDEFGHJKLM", false, geraet.token);
		cleanupExpired(db);
		expect(codes()).toEqual(["ABCDEFGHJKLM"]);
		expect(deviceFromToken(db, geraet.token)).not.toBeNull();
	});
});
