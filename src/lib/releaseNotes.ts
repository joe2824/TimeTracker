// Was aus den Release-Notes im Update-Dialog landet.

/**
 * Nur die Zeilen unter „Wichtig vor dem Update".
 *
 * Der Dialog zeigte frueher den ganzen Release-Text - als Rohtext, mit
 * Markdown-Zeichen und Zeilen, die nur auf GitHub Sinn ergeben. Was jemand vor
 * dem Update wirklich wissen muss, sind die Breaking Changes; alles andere
 * erzaehlt der „Was ist neu"-Dialog beim Start eines Haupt-Releases.
 *
 * Die Ueberschrift kommt aus `.github/workflows/release.yml`. Erkannt wird sie
 * ueber den Text, nicht ueber Emoji oder Ebene - beides darf sich aendern.
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
