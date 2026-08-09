import { describe, expect, it } from "vitest";
import { redact } from "./analytics";

// redact() ist die letzte Schranke vor dem Netz: was hier durchrutscht, liegt
// hinterher bei einem Dritten. Deshalb je Muster ein Fall.
describe("redact", () => {
	it("entfernt Mailadressen", () => {
		expect(redact("Entwurf an chef@firma.de fehlgeschlagen")).toBe(
			"Entwurf an <mail> fehlgeschlagen"
		);
	});

	it("entfernt Windows-Pfade samt Benutzername", () => {
		expect(redact("C:\\Users\\Joel\\Desktop\\Bericht.csv nicht schreibbar")).toBe(
			"<pfad> nicht schreibbar"
		);
	});

	it("entfernt UNC-Pfade", () => {
		expect(redact("\\\\fileserver\\team\\export.csv")).toBe("<pfad>");
	});

	it("entfernt POSIX-Pfade", () => {
		expect(redact("/Users/joel/Library/x.json nicht lesbar")).toBe("<pfad> nicht lesbar");
	});

	it("entfernt lange Ziffernfolgen (Personalnummern)", () => {
		expect(redact("Person 4711234 unbekannt")).toBe("Person <zahl> unbekannt");
	});

	it("laesst kurze Zahlen und Versionen stehen", () => {
		expect(redact("Update 0.7.1 fehlgeschlagen")).toBe("Update 0.7.1 fehlgeschlagen");
	});

	it("laesst reine Meldungstexte unveraendert", () => {
		expect(redact("Outlook antwortet nicht")).toBe("Outlook antwortet nicht");
	});

	it("kuerzt auf 120 Zeichen", () => {
		expect(redact("x".repeat(500))).toHaveLength(120);
	});

	it("schluckt eine Mailadresse auch mitten im Satz mit Klammern", () => {
		expect(redact("(a.b@x.co) fehlt")).toBe("(<mail>) fehlt");
	});
});
