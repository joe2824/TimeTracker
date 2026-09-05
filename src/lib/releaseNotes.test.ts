import { describe, it, expect } from "vitest";
import { breakingNotes } from "./releaseNotes";

/** So sieht der Text aus, den release.yml erzeugt und tauri-action ausliefert. */
const withBreaking = `## TimeTracker v1.0.0

### ⚠️ Wichtig vor dem Update
- Bestehende Geräte müssen einmalig neu verknüpft werden.
- Die alte Serveradresse gilt nicht mehr.

### Neue Funktionen
- Beim Beenden wird der letzte Stand noch hochgeladen.

### Fehlerbehebungen
- Daten gehen nicht mehr verloren, wenn zwei Geräte gleichzeitig abgleichen.

**Vollständiges Changelog**: https://github.com/joe2824/TimeTracker/compare/v0.9.4...v1.0.0

Installer/Bundles siehe Assets unten.`;

const routine = `## TimeTracker v0.9.5

### Fehlerbehebungen
- Daten gehen nicht mehr verloren, wenn zwei Geräte gleichzeitig abgleichen.

Installer/Bundles siehe Assets unten.`;

describe("breakingNotes", () => {
	it("nimmt nur die Zeilen unter der Warnung", () => {
		expect(breakingNotes(withBreaking)).toEqual([
			"Bestehende Geräte müssen einmalig neu verknüpft werden.",
			"Die alte Serveradresse gilt nicht mehr."
		]);
	});

	it("gibt nichts zurück, wenn es keine Warnung gibt", () => {
		// Der Dialog bleibt dann still - genau das ist der Sinn.
		expect(breakingNotes(routine)).toEqual([]);
	});

	it("hört bei der nächsten Überschrift auf", () => {
		// Ohne das rutschten Neue Funktionen und Fehlerbehebungen mit hinein.
		expect(breakingNotes(withBreaking)).not.toContain(
			"Beim Beenden wird der letzte Stand noch hochgeladen."
		);
	});

	it("kommt ohne Notes zurecht", () => {
		expect(breakingNotes(null)).toEqual([]);
		expect(breakingNotes(undefined)).toEqual([]);
		expect(breakingNotes("")).toEqual([]);
	});

	it("liest auch CRLF, wie es in latest.json steht", () => {
		// Das ausgelieferte latest.json trägt \r\n - ohne Normalisierung bliebe
		// an jeder Zeile ein \r hängen.
		expect(breakingNotes(withBreaking.replace(/\n/g, "\r\n"))).toEqual([
			"Bestehende Geräte müssen einmalig neu verknüpft werden.",
			"Die alte Serveradresse gilt nicht mehr."
		]);
	});

	it("hängt nicht am Emoji oder an der Ebene der Überschrift", () => {
		expect(breakingNotes("## Wichtig vor dem Update\n- Etwas ändert sich.")).toEqual([
			"Etwas ändert sich."
		]);
	});

	it("nimmt keine Fließtextzeile, die keine Aufzählung ist", () => {
		const body = "### Wichtig vor dem Update\nEinleitung ohne Strich\n- Der echte Punkt.";
		expect(breakingNotes(body)).toEqual(["Der echte Punkt."]);
	});
});
