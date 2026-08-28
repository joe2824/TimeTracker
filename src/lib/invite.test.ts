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

	it("traegt den Kopplungscode NICHT mit", () => {
		// Der Code ist der Abdruck des Geraeteschluessels und der einzige
		// Anhaltspunkt, an dem ein Mensch den eigenen Rechner von einem
		// untergeschobenen Vorgang unterscheidet. In einer Adresse landete er in
		// der Chronik - und der Vergleich waere zur Formsache geworden, weil der
		// Code schon im Feld stuende. Er wird abgetippt.
		expect(anlegenLink("http://localhost:3000")).toBe("http://localhost:3000/?neu=1");
		expect(anlegenLink("http://localhost:3000")).not.toContain("pair");
	});
});
