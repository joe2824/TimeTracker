import { describe, expect, it } from "vitest";
import { istPairingCode, normalisiereCode, PAIRING_CODE_LENGTH } from "./pairing";

describe("normalisiereCode", () => {
	it("nimmt den Code so an, wie er angezeigt wird", () => {
		// Angezeigt wird "ABCD-EFGH-JKLM". Wer die Bindestriche mittippt, soll
		// nicht scheitern - und wer sie weglaesst, ebenso wenig.
		expect(normalisiereCode("ABCD-EFGH-JKLM")).toBe("ABCDEFGHJKLM");
		expect(normalisiereCode("ABCDEFGHJKLM")).toBe("ABCDEFGHJKLM");
		expect(normalisiereCode(" abcd efgh jklm ")).toBe("ABCDEFGHJKLM");
	});

	it("haelt auch das aus, was gar kein Code ist", () => {
		expect(normalisiereCode(null)).toBe("");
		expect(normalisiereCode(undefined)).toBe("");
		expect(normalisiereCode(42)).toBe("42");
	});
});

describe("istPairingCode", () => {
	it("nimmt einen Abdruck der richtigen Laenge an", () => {
		expect(istPairingCode("ABCDEFGHJKLM")).toBe(true);
		expect(istPairingCode("222222222222")).toBe(true);
	});

	it("weist alles ab, was nicht die Form eines Abdrucks hat", () => {
		// Der alte, gewuerfelte Code hatte acht Stellen. Er darf nicht mehr durch:
		// zwoelf Stellen sind kein Schoenheitsentscheid, sondern der Abstand
		// zwischen 40 und 60 Bit - und 40 Bit faellt auf einer Grafikkarte,
		// waehrend die Kopplung noch offen steht.
		expect(istPairingCode("ABCD2345")).toBe(false);
		expect(istPairingCode("")).toBe(false);
		expect(istPairingCode("ABCDEFGHJKLMN")).toBe(false);
		// Kleinbuchstaben gehoeren normalisiert, nicht geprueft.
		expect(istPairingCode("abcdefghjklm")).toBe(false);
		// I, O, 0 und 1 sind nicht im Alphabet - sie werden verwechselt.
		expect(istPairingCode("ABCDEFGHJKL0")).toBe(false);
		expect(istPairingCode("ABCDEFGHJKLI")).toBe(false);
	});

	it("nimmt an, was normalisiereCode aus der Anzeige macht", () => {
		expect(istPairingCode(normalisiereCode("ABCD-EFGH-JKLM"))).toBe(true);
		expect(PAIRING_CODE_LENGTH).toBe(12);
	});
});
