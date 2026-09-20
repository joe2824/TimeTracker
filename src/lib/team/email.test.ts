import { describe, expect, it } from "vitest";
import { cleanEmail } from "$shared/email";

describe("cleanEmail", () => {
	it("nimmt eine einzelne Adresse an und trimmt sie", () => {
		expect(cleanEmail("  anna@firma.de ")).toBe("anna@firma.de");
	});

	it("nimmt einen Apostroph im Namen an", () => {
		expect(cleanEmail("o'brien@firma.de")).toBe("o'brien@firma.de");
	});

	it.each(["anna@firma.de; fremd@firma.de", "anna@firma.de, fremd@firma.de", "anna@firma.de fremd@firma.de", "<anna@firma.de>", "keine-adresse", "", "a@b"])(
		"weist %j ab",
		(input) => {
			expect(cleanEmail(input)).toBeNull();
		}
	);

	it("weist Nicht-Text und zu lange Eingaben ab", () => {
		expect(cleanEmail(undefined)).toBeNull();
		expect(cleanEmail(42)).toBeNull();
		expect(cleanEmail(`${"a".repeat(200)}@firma.de`)).toBeNull();
	});
});
