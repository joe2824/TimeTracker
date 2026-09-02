import { describe, expect, it } from "vitest";
import { isPairingCode, normalizePairingCode, PAIRING_CODE_LENGTH } from "./pairing";

describe("normalisiereCode", () => {
	it("nimmt den Code so an, wie er angezeigt wird", () => {
		// Angezeigt wird "ABCD-EFGH-JKLM". Wer die Bindestriche mittippt, soll
		// nicht scheitern - und wer sie weglaesst, ebenso wenig.
		expect(normalizePairingCode("ABCD-EFGH-JKLM")).toBe("ABCDEFGHJKLM");
		expect(normalizePairingCode("ABCDEFGHJKLM")).toBe("ABCDEFGHJKLM");
		expect(normalizePairingCode(" abcd efgh jklm ")).toBe("ABCDEFGHJKLM");
	});

	it("haelt auch das aus, was gar kein Code ist", () => {
		expect(normalizePairingCode(null)).toBe("");
		expect(normalizePairingCode(undefined)).toBe("");
		expect(normalizePairingCode(42)).toBe("42");
	});
});

describe("istPairingCode", () => {
	it("nimmt einen Abdruck der richtigen Laenge an", () => {
		expect(isPairingCode("ABCDEFGHJKLM")).toBe(true);
		expect(isPairingCode("222222222222")).toBe(true);
	});

	it("weist alles ab, was nicht die Form eines Abdrucks hat", () => {
		// Acht Stellen sind zu wenig: zwoelf Stellen sind kein Schoenheitsentscheid,
		// sondern der Abstand zwischen 40 und 60 Bit - und 40 Bit faellt auf einer
		// Grafikkarte, waehrend die Kopplung noch offen steht.
		expect(isPairingCode("ABCD2345")).toBe(false);
		expect(isPairingCode("")).toBe(false);
		expect(isPairingCode("ABCDEFGHJKLMN")).toBe(false);
		// Kleinbuchstaben gehoeren normalisiert, nicht geprueft.
		expect(isPairingCode("abcdefghjklm")).toBe(false);
		// I, O, 0 und 1 sind nicht im Alphabet - sie werden verwechselt.
		expect(isPairingCode("ABCDEFGHJKL0")).toBe(false);
		expect(isPairingCode("ABCDEFGHJKLI")).toBe(false);
	});

	it("nimmt an, was normalisiereCode aus der Anzeige macht", () => {
		expect(isPairingCode(normalizePairingCode("ABCD-EFGH-JKLM"))).toBe(true);
		expect(PAIRING_CODE_LENGTH).toBe(12);
	});
});
