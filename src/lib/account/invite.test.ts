// Was ein Link an die Anmeldeseite mitbringt.
import { describe, expect, it } from "vitest";
import { createLink, inviteLink } from "./invite";

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
		expect(createLink("https://tracker.example.de")).toBe("https://tracker.example.de/?neu=1");
	});

	it("traegt den Kopplungscode NICHT mit", () => {
		// Der Code ist der Abdruck des Geräteschlüssels und der einzige
		// Anhaltspunkt, an dem ein Mensch den eigenen Rechner von einem
		// untergeschobenen Vorgang unterscheidet. In einer Adresse landete er in
		// der Chronik - und der Vergleich wäre zur Formsache geworden, weil der
		// Code schon im Feld stünde. Er wird abgetippt.
		expect(createLink("http://localhost:3000")).toBe("http://localhost:3000/?neu=1");
		expect(createLink("http://localhost:3000")).not.toContain("pair");
	});

	// Wer die Adresse ohne Schema eintippt, bekam eine unbrauchbare URL: der
	// Browser ging auf, zeigte aber nichts.
	it("ergänzt ein fehlendes Schema, statt die Adresse zu zerlegen", () => {
		expect(createLink("tt.example.de")).toBe("https://tt.example.de/?neu=1");
		expect(createLink("192.168.1.5:3000")).toBe("https://192.168.1.5:3000/?neu=1");
	});

	it("lässt die Platzhalter-Basis nie nach draußen", () => {
		for (const raw of ["tt.example.de", "localhost:5173", "192.168.1.5:3000"]) {
			expect(createLink(raw)).not.toContain("ungenutzt");
			expect(createLink(raw).startsWith("http")).toBe(true);
		}
	});
});
