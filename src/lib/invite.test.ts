// Was ein Link an die Anmeldeseite mitbringt.
import { describe, expect, it } from "vitest";
import { anlegenLink, inviteLink } from "./invite";

describe("inviteLink", () => {
	it("haengt den Code an die Serveradresse", () => {
		expect(inviteLink("https://tracker.example.de", "ABCD-EFGH")).toBe(
			"https://tracker.example.de/?invite=ABCD-EFGH"
		);
	});

	it("vertraegt einen Schraegstrich am Ende", () => {
		expect(inviteLink("https://tracker.example.de/", "ABCD")).toBe(
			"https://tracker.example.de/?invite=ABCD"
		);
	});

	it("bleibt relativ, wenn keine Adresse bekannt ist", () => {
		expect(inviteLink("", "ABCD")).toBe("/?invite=ABCD");
	});
});

describe("anlegenLink", () => {
	it("springt direkt zum Anlegen", () => {
		expect(anlegenLink("https://tracker.example.de")).toBe("https://tracker.example.de/?neu=1");
	});

	it("nimmt den Kopplungscode mit", () => {
		// Damit der Browser den Rechner danach ohne Abtippen bestaetigen kann.
		expect(anlegenLink("http://localhost:3000", "ABCDEFGHJKLM")).toBe(
			"http://localhost:3000/?neu=1&pair=ABCDEFGHJKLM"
		);
	});
});
