// Einladungscodes: prüfen, entwerten, Schreibweise verzeihen.
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { keepEnv } from "./testing/fixtures";
import type { Db } from "./db/index";

keepEnv("INVITE_CODES", "REGISTRATION_OPEN");

/** Ein statischer Code in Code-Form und einer in freier Form. */
const ENV_SHAPED = "ABCD-EFGH-JKLM-NPQR";
const ENV_FREE = "Familie2026";
/** Code-Form plus ein Zeichen ausserhalb des Alphabets. */
const ENV_PADDED = "STUV-WXYZ-2345-6789-0";

let inv: typeof import("./invites");
let fixtures: typeof import("./testing/fixtures");
let db: Db;

beforeAll(async () => {
	vi.resetModules();
	process.env.INVITE_CODES = `${ENV_SHAPED},${ENV_FREE},${ENV_PADDED}`;
	delete process.env.REGISTRATION_OPEN;
	inv = await import("./invites");
	fixtures = await import("./testing/fixtures");
});

beforeEach(() => {
	db = fixtures.freshDb();
});

describe("consumeInviteCode", () => {
	it("entwertet einen Tabellen-Code genau einmal", () => {
		const { code } = inv.createInvite(db, fixtures.ANNA);
		expect(inv.consumeInviteCode(db, code, "konto-1")).toBe(true);
		// Der zweite Abschluss, der vor dem ersten geprüft hatte, darf kein Konto bekommen.
		expect(inv.consumeInviteCode(db, code, "konto-2")).toBe(false);
		expect(inv.listInvites(db)[0].usedBy).toBe("konto-1");
	});

	it("entwertet keinen zurückgezogenen Code", () => {
		const { code } = inv.createInvite(db, fixtures.ANNA);
		expect(inv.isValidInviteCode(db, code)).toBe(true);
		inv.revokeInvite(db, code);
		expect(inv.consumeInviteCode(db, code, "konto-1")).toBe(false);
		expect(inv.listInvites(db)[0].usedAt).toBeNull();
	});

	it("entwertet keinen abgelaufenen Code", () => {
		const { code } = inv.createInvite(db, fixtures.ANNA, { expiresAt: Date.now() - 1 });
		expect(inv.isValidInviteCode(db, code)).toBe(false);
		expect(inv.consumeInviteCode(db, code, "konto-1")).toBe(false);
	});

	it("statische Codes gelten mehrfach", () => {
		expect(inv.consumeInviteCode(db, ENV_FREE, "konto-1")).toBe(true);
		expect(inv.consumeInviteCode(db, ENV_FREE, "konto-2")).toBe(true);
	});

	it("statische Codes gelten nicht mehr, wenn der Verwalter sie abschaltet", () => {
		inv.setEnvInvitesDisabled(db, true);
		expect(inv.isValidInviteCode(db, ENV_FREE)).toBe(false);
		expect(inv.consumeInviteCode(db, ENV_FREE, "konto-1")).toBe(false);
	});
});

describe("Schreibweise", () => {
	it("verzeiht Kleinschreibung, Leerzeichen und fehlende Striche bei Tabellen-Codes", () => {
		const { code } = inv.createInvite(db, fixtures.ANNA);
		const typed = ` ${code.toLowerCase().replaceAll("-", " ")} `;
		expect(inv.isValidInviteCode(db, typed)).toBe(true);
		expect(inv.consumeInviteCode(db, typed, "konto-1")).toBe(true);
		expect(inv.isValidInviteCode(db, code)).toBe(false);
	});

	it("verzeiht die Schreibweise auch bei statischen Codes in Code-Form", () => {
		expect(inv.isValidInviteCode(db, "abcdefghjklmnpqr")).toBe(true);
	});

	it("lässt bei statischen Codes nur Striche und Leerzeichen weg", () => {
		expect(inv.isValidInviteCode(db, ENV_PADDED)).toBe(true);
		expect(inv.isValidInviteCode(db, "STUV-WXYZ-2345-6789")).toBe(false);
	});

	it("nimmt statische Codes in freier Form nur wörtlich", () => {
		expect(inv.isValidInviteCode(db, ENV_FREE)).toBe(true);
		expect(inv.isValidInviteCode(db, "familie2026")).toBe(false);
	});
});
