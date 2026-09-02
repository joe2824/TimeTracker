// Ein Passkey ohne Verpackung ist ein Vault ohne Schluessel - und das faellt
// erst auf, wenn jemand sich auf einem neuen Geraet anmeldet. Deshalb entstehen
// beide in EINER Transaktion.
import { beforeEach, describe, expect, it } from "vitest";
import { openDb, type Db } from "./db";
import { credentials, keyWraps, users } from "./db/schema";
import { storeWrap, readWrap } from "./wraps";
import { storeCredential } from "./webauthn";
import { listPasskeys } from "./passkeys";
import { hashSecret } from "./auth";
import { eq } from "drizzle-orm";

let db: Db;

const ANNA = "user-anna";
const BODO = "user-bodo";

function create(id: string) {
	db.insert(users).values({ id, displayName: id, createdAt: 1, seqCounter: 0 }).run();
}

const cred = (id: string) => ({ id, publicKey: new Uint8Array([1, 2, 3]), counter: 0 });

beforeEach(() => {
	db = openDb(":memory:").db;
	create(ANNA);
	create(BODO);
});

describe("storeWrap", () => {
	it("legt Kennung und Nachweis zur Phrase ab - den Nachweis nur als Hash", () => {
		db.transaction((tx) =>
			storeWrap(tx, ANNA, {
				kind: "recovery",
				payload: "{}",
				recoveryId: "kennung-a",
				vaultProof: "nachweis-a"
			})
		);

		const user = db.select().from(users).where(eq(users.id, ANNA)).get();
		expect(user?.recoveryId).toBe("kennung-a");
		expect(user?.vaultProof).toBe(hashSecret("nachweis-a"));
		expect(user?.vaultProof).not.toBe("nachweis-a");
	});

	it("eine neue Phrase macht die alte ungueltig", () => {
		const put = (id: string) =>
			db.transaction((tx) =>
				storeWrap(tx, ANNA, {
					kind: "recovery",
					payload: id,
					recoveryId: id,
					vaultProof: id
				})
			);
		put("erste");
		put("zweite");

		const rows = db.select().from(keyWraps).where(eq(keyWraps.userId, ANNA)).all();
		expect(rows).toHaveLength(1);
		expect(rows[0].payload).toBe("zweite");
	});

	it("je Passkey genau eine Verpackung", () => {
		const put = (payload: string) =>
			db.transaction((tx) =>
				storeWrap(tx, ANNA, { kind: "passkey", payload, credentialId: "cred-1" })
			);
		put("alt");
		put("neu");

		const rows = db.select().from(keyWraps).where(eq(keyWraps.userId, ANNA)).all();
		expect(rows).toHaveLength(1);
		expect(rows[0].payload).toBe("neu");
	});

	it("dieselbe Kennung bei zwei Konten hiesse dieselbe Phrase bei zweien", () => {
		db.transaction((tx) =>
			storeWrap(tx, ANNA, { kind: "recovery", payload: "{}", recoveryId: "k", vaultProof: "n" })
		);

		expect(() =>
			db.transaction((tx) =>
				storeWrap(tx, BODO, { kind: "recovery", payload: "{}", recoveryId: "k", vaultProof: "n" })
			)
		).toThrow();
	});

	it("Kennung ohne Nachweis wird abgelehnt", () => {
		expect(() =>
			db.transaction((tx) =>
				storeWrap(tx, ANNA, { kind: "recovery", payload: "{}", recoveryId: "k" })
			)
		).toThrow();
	});
});

describe("Passkey und Verpackung entstehen zusammen", () => {
	it("beides oder nichts - bricht die Verpackung ab, bleibt kein Passkey stehen", () => {
		// Fremde Kennung: die Verpackung wirft, nachdem der Passkey schon
		// geschrieben wurde. Genau die Reihenfolge aus register/finish.
		db.transaction((tx) =>
			storeWrap(tx, BODO, { kind: "recovery", payload: "{}", recoveryId: "belegt", vaultProof: "n" })
		);

		expect(() =>
			db.transaction((tx) => {
				storeCredential(tx, ANNA, cred("cred-neu"), undefined, true);
				storeWrap(tx, ANNA, {
					kind: "recovery",
					payload: "{}",
					recoveryId: "belegt",
					vaultProof: "n"
				});
			})
		).toThrow();

		expect(db.select().from(credentials).where(eq(credentials.userId, ANNA)).all()).toEqual([]);
		expect(db.select().from(keyWraps).where(eq(keyWraps.userId, ANNA)).all()).toEqual([]);
	});

	it("geht es durch, steht zu jedem Passkey eine Verpackung", () => {
		db.transaction((tx) => {
			storeCredential(tx, ANNA, cred("cred-1"), undefined, true);
			storeWrap(tx, ANNA, { kind: "recovery", payload: "r", recoveryId: "k", vaultProof: "n" });
			storeWrap(tx, ANNA, { kind: "passkey", payload: "p", credentialId: "cred-1" });
		});

		const rows = db.select().from(credentials).where(eq(credentials.userId, ANNA)).all();
		const wraps = db.select().from(keyWraps).where(eq(keyWraps.userId, ANNA)).all();
		for (const row of rows) {
			expect(wraps.some((w) => w.kind === "passkey" && w.credentialId === row.id)).toBe(true);
		}
		expect(wraps.some((w) => w.kind === "recovery")).toBe(true);
	});
});

describe("readWrap", () => {
	it("ohne payload gibt es nichts abzulegen", () => {
		expect(() => readWrap({}, "recovery")).toThrow();
		expect(() => readWrap(null, "recovery")).toThrow();
	});

	it("liest Kennung und Nachweis mit", () => {
		expect(readWrap({ payload: "x", recoveryId: "k", vaultProof: "n" }, "recovery")).toEqual({
			kind: "recovery",
			payload: "x",
			credentialId: null,
			recoveryId: "k",
			vaultProof: "n"
		});
	});
});

describe("listPasskeys", () => {
	it("liefert Namen und Verpackung - beides las die Verwaltung aus /me", () => {
		db.transaction((tx) => {
			storeCredential(tx, ANNA, cred("mit-wrap"), undefined, true, "Touch ID");
			storeCredential(tx, ANNA, cred("ohne-wrap"), undefined, true, "YubiKey");
			storeWrap(tx, ANNA, { kind: "passkey", payload: "p", credentialId: "mit-wrap" });
		});

		const rows = listPasskeys(db, ANNA);
		expect(rows.find((p) => p.id === "mit-wrap")).toMatchObject({
			label: "Touch ID",
			hasWrap: true
		});
		expect(rows.find((p) => p.id === "ohne-wrap")).toMatchObject({
			label: "YubiKey",
			hasWrap: false
		});
	});
});
