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
		expect(redact("C:\\Users\\Anna\\Desktop\\Bericht.csv nicht schreibbar")).toBe(
			"<pfad> nicht schreibbar"
		);
	});

	it("entfernt UNC-Pfade", () => {
		expect(redact("\\\\fileserver\\team\\export.csv")).toBe("<pfad>");
	});

	it("entfernt POSIX-Pfade", () => {
		expect(redact("/Users/anna/Library/x.json nicht lesbar")).toBe("<pfad> nicht lesbar");
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

describe("detectPlatform", () => {
	it("gibt einen gueltigen Plattform-String zurueck", async () => {
		const { detectPlatform } = await import("./analytics");
		const plat = detectPlatform();
		expect(typeof plat).toBe("string");
		expect(plat.length).toBeGreaterThan(0);
	});
});

describe("sendDailyTelemetryPing", () => {
	it("wirft keine Fehler bei fehlendem Server oder Netzwerkfehlern", async () => {
		const { sendDailyTelemetryPing } = await import("./analytics");
		await expect(sendDailyTelemetryPing("http://localhost:99999")).resolves.not.toThrow();
		await expect(sendDailyTelemetryPing("")).resolves.not.toThrow();
	});
});

