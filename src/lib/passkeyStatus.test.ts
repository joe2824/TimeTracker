// Ein Konto kann mehrere Passkeys haben - es zaehlt aber nur der dieses Browsers.
import { describe, expect, it } from "vitest";
import { missingPasskey } from "./passkeyStatus";

const pk = (id: string, hasWrap: boolean) => ({ id, hasWrap });

describe("missingPasskey", () => {
	it("ohne Passkey fehlt der Passkey", () => {
		expect(missingPasskey([], null)).toBe("passkey");
		expect(missingPasskey([], "irgendeiner")).toBe("passkey");
	});

	it("der eigene mit Verpackung: nichts fehlt", () => {
		expect(missingPasskey([pk("a", true)], "a")).toBeNull();
	});

	it("der eigene ohne Verpackung, obwohl ein anderer eine hat", () => {
		// Der Fall, den die kontoweite Pruefung uebersah: an einem anderen Browser
		// haengt eine Verpackung, hier nicht - und hier nuetzt sie nichts.
		expect(missingPasskey([pk("a", true), pk("b", false)], "b")).toBe("wrap");
	});

	it("ein fremder ohne Verpackung geht diesen Browser nichts an", () => {
		expect(missingPasskey([pk("a", true), pk("b", false)], "a")).toBeNull();
	});

	it("ohne bekannte Kennung zaehlt das ganze Konto", () => {
		// Nach einer Anmeldung mit den 24 Woertern oder ueber eine Kopplung ist
		// nicht zu sagen, welcher Eintrag der eigene ist.
		expect(missingPasskey([pk("a", false), pk("b", false)], null)).toBe("wrap");
		expect(missingPasskey([pk("a", true), pk("b", false)], null)).toBeNull();
	});

	it("eine Kennung, die es nicht mehr gibt, faellt auf das Konto zurueck", () => {
		expect(missingPasskey([pk("a", false)], "weg")).toBe("wrap");
	});
});
