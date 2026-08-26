// Was aus der PRF-Erweiterung herauskommt, kommt in vielerlei Gestalt.
import { describe, expect, it } from "vitest";
import { prfBytes } from "./enroll";

describe("prfBytes", () => {
	it("nimmt einen ArrayBuffer", () => {
		const b = new Uint8Array([1, 2, 3]).buffer;
		expect(prfBytes(b)).toEqual(new Uint8Array([1, 2, 3]));
	});

	it("nimmt eine Uint8Array", () => {
		expect(prfBytes(new Uint8Array([9, 8]))).toEqual(new Uint8Array([9, 8]));
	});

	it("beachtet den Versatz einer Ansicht", () => {
		const voll = new Uint8Array([0, 0, 7, 7]);
		expect(prfBytes(voll.subarray(2))).toEqual(new Uint8Array([7, 7]));
	});

	it("nimmt base64 und base64url", () => {
		expect(prfBytes("AQID")).toEqual(new Uint8Array([1, 2, 3]));
		expect(prfBytes("--8=".replace("--", "//"))).toEqual(prfBytes("//8="));
	});

	it("nimmt ein durchnummeriertes Objekt", () => {
		expect(prfBytes({ 0: 4, 1: 5 })).toEqual(new Uint8Array([4, 5]));
	});

	it("null bleibt null", () => {
		expect(prfBytes(undefined)).toBeNull();
		expect(prfBytes(null)).toBeNull();
	});

	it("wirft verstaendlich statt in SubtleCrypto zu laufen", () => {
		// Ein leeres Objekt ist der Fall, in dem der Wert unterwegs verloren ging.
		expect(() => prfBytes({})).toThrow(/unbekannter Form/);
	});
});
