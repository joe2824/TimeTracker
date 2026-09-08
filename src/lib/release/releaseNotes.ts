// Was aus den Release-Notes im Update-Dialog landet.

/**
 * Nur die Zeilen unter „Wichtig vor dem Update".
 *
 * Der Update-Dialog zeigt ausschließlich Breaking Changes — alles andere erzählt
 * der „Was ist neu"-Dialog beim Start eines Haupt-Releases. Der übrige
 * Release-Text taugt dort ohnehin nicht: er trägt Markdown-Zeichen und Zeilen,
 * die nur auf GitHub Sinn ergeben.
 *
 * Die Überschrift kommt aus `.github/workflows/release.yml` und wird über ihren
 * Text erkannt, nicht über Emoji oder Ebene — beides darf sich ändern.
 */
export function breakingNotes(body: string | null | undefined): string[] {
	if (!body) return [];
	const lines = body.replace(/\r\n/g, "\n").split("\n");
	const start = lines.findIndex((l) => /^#+\s*.*Wichtig vor dem Update/i.test(l));
	if (start < 0) return [];

	const out: string[] = [];
	for (const line of lines.slice(start + 1)) {
		if (/^#+\s/.test(line)) break;
		const item = line.match(/^\s*[-*]\s+(.*\S)\s*$/);
		if (item) out.push(item[1]);
	}
	return out;
}
