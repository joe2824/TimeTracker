// Welches Betriebssystem der Browser meldet.

export type OperatingSystem = "windows" | "macos" | "linux" | "mobil" | "unbekannt";

/**
 * Grob raten, worauf das hier laeuft - fuer die Auswahl des Downloads.
 *
 * Bewusst grob: die Angabe entscheidet nur, welcher Knopf oben steht. Wer sich
 * nicht wiedererkennt, findet die uebrigen Dateien trotzdem auf der
 * Release-Seite, und ein Fehlgriff kostet niemanden mehr als einen Klick.
 *
 * `userAgentData` zuerst, weil der User-Agent-Text seit Jahren eingefroren wird
 * und dort z. B. jedes Windows als "Windows NT 10.0" steht.
 */
export function detectOs(): OperatingSystem {
	if (typeof navigator === "undefined") return "unbekannt";

	const uaData = (navigator as Navigator & { userAgentData?: { platform?: string; mobile?: boolean } })
		.userAgentData;
	if (uaData?.mobile) return "mobil";

	const raw = `${uaData?.platform ?? ""} ${navigator.platform ?? ""} ${navigator.userAgent ?? ""}`;

	// Android meldet auch "Linux" - deshalb zuerst.
	if (/Android|iPhone|iPad|iPod/i.test(raw)) return "mobil";
	if (/Win/i.test(raw)) return "windows";
	// "Mac" trifft auch iPadOS im Desktop-Modus; das ist oben schon weg.
	if (/Mac/i.test(raw)) return "macos";
	if (/Linux|X11|CrOS/i.test(raw)) return "linux";
	return "unbekannt";
}

/**
 * Gibt es die Desktop-Anwendung fuer dieses System?
 *
 * Gebaut wird bisher nur fuer Windows (siehe .github/workflows/release.yml).
 * Solange das so ist, waere ein Download-Knopf fuer alles andere ein Versprechen
 * ohne Datei dahinter.
 */
export function hasDesktopApp(os: OperatingSystem): boolean {
	return os === "windows";
}

/** Das Vorhaben selbst. */
export const REPO_URL = "https://github.com/joe2824/TimeTracker";

/** Wo die Installer liegen. Die Dateinamen tragen die Version, die Seite nicht. */
export const RELEASES_URL = `${REPO_URL}/releases/latest`;

/** Das Nachschlagewerk. */
export const WIKI_URL = `${REPO_URL}/wiki`;

/** Das Server-Abbild in der GitHub-Registry. Siehe .github/workflows/docker.yml. */
export const IMAGE_REF = "ghcr.io/joe2824/timetracker-server:latest";
