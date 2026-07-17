import { describe, expect, it } from "vitest";
import { mailtoFallback } from "./outlook";

describe("mailtoFallback", () => {
	const M = mailtoFallback("chef@firma.de", "Stundenerfassung Juli 2026 – Joel Klein", "Zeile eins\nZeile zwei");

	it("kodiert Leerzeichen NICHT als +", () => {
		// URLSearchParams macht "+" daraus (Formular-Kodierung); mailto nimmt das
		// laut RFC 6068 wörtlich – der Betreff kam als
		// "Stundenerfassung+Juli+2026+–+Joel+Klein" bei den Vorgesetzten an.
		expect(M).not.toContain("+");
		expect(M).toContain("Stundenerfassung%20Juli%202026");
	});

	it("kodiert Empfänger, Betreff und Text", () => {
		expect(M.startsWith("mailto:chef%40firma.de?")).toBe(true);
		expect(M).toContain("subject=");
		expect(M).toContain("body=");
		expect(M).toContain("%0A"); // Zeilenumbruch im Text
	});

	it("übersteht Zeichen, die die URL sprengen würden", () => {
		const m = mailtoFallback("a@b.de", "Bericht & Co: 50% ?done", "x=1&y=2");
		expect(m).toContain("%26"); // &
		expect(m).toContain("%3F"); // ?
		expect(m).toContain("%25"); // %
		expect(m).not.toContain("+");
	});
});
