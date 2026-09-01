import { beforeEach, describe, expect, it } from "vitest";
import { openDb, type Db } from "./db";
import { devices, pairings, users } from "./db/schema";
import { cleanupExpired, createDevice, deviceFromToken } from "./auth";
import { eq } from "drizzle-orm";

let db: Db;

const ANNA = "user-anna";

/** Eine Kopplung, wie sie /api/pair/start hinterlaesst - Zeitpunkt frei waehlbar. */
function pairing(code: string, expired: boolean, deviceToken?: string) {
	const nowMs = Date.now();
	db.insert(pairings)
		.values({
			code,
			userId: deviceToken ? ANNA : null,
			publicKey: "cHVibGljLWtleQ==",
			label: "Rechner",
			wrappedKey: deviceToken ? "cGFrZXQ=" : null,
			deviceToken: deviceToken ?? null,
			createdAt: nowMs - 60_000,
			expiresAt: expired ? nowMs - 1000 : nowMs + 600_000
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
		pairing("ABCDEFGHJKLM", true);
		cleanupExpired(db);
		expect(codes()).toEqual([]);
	});

	it("laesst eine laufende Kopplung in Ruhe", () => {
		pairing("ABCDEFGHJKLM", false);
		cleanupExpired(db);
		expect(codes()).toEqual(["ABCDEFGHJKLM"]);
	});

	it("widerruft das Geraet einer bestaetigten, nie abgeholten Kopplung", () => {
		// Der gefaehrliche Fall: jemand hat bestaetigt, das neue Geraet ist nie
		// erschienen. Das Token gilt, aber niemand hatte es je in der Hand - es
		// laege sonst im Klartext in der Zeile und zaehlte weiter als Geraet.
		const deviceRow = createDevice(db, ANNA, "Rechner");
		pairing("ABCDEFGHJKLM", true, deviceRow.token);

		expect(deviceFromToken(db, deviceRow.token)).not.toBeNull();
		cleanupExpired(db);

		expect(codes()).toEqual([]);
		expect(deviceFromToken(db, deviceRow.token)).toBeNull();
		expect(db.select().from(devices).where(eq(devices.id, deviceRow.id)).get()?.revokedAt).toBeTypeOf(
			"number"
		);
	});

	it("laesst ein abgeholtes Geraet in Ruhe", () => {
		// Wer abholt, loescht seine Kopplungszeile dabei selbst. Es darf nicht
		// passieren, dass das Aufraeumen ein Geraet trifft, das laengst laeuft.
		const deviceRow = createDevice(db, ANNA, "Rechner");
		cleanupExpired(db);
		expect(deviceFromToken(db, deviceRow.token)).toEqual({ userId: ANNA, deviceId: deviceRow.id });
	});

	it("ruehrt ein Geraet nicht an, das zu einer laufenden Kopplung gehoert", () => {
		const deviceRow = createDevice(db, ANNA, "Rechner");
		pairing("ABCDEFGHJKLM", false, deviceRow.token);
		cleanupExpired(db);
		expect(codes()).toEqual(["ABCDEFGHJKLM"]);
		expect(deviceFromToken(db, deviceRow.token)).not.toBeNull();
	});
});
