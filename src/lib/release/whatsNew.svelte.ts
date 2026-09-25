// Verwaltung des „Was ist neu“-Dialogs für Haupt-Releases.
import { isTauri } from "../platform/env";

const STORAGE_KEY = "timetracker:last_seen_release";

export interface ReleaseHighlight {
	icon: "cloud" | "shield" | "key" | "database" | "sparkles" | "users";
	title: string;
	description: string;
}

export interface ReleaseInfo {
	version: string;
	title: string;
	summary: string;
	highlights: ReleaseHighlight[];
}

/**
 * Das Release, das dieser Inhalt beschreibt - NICHT die laufende App-Version.
 *
 * `checkOnStartup` vergleicht nur diese Zeichenkette mit dem, was zuletzt
 * gesehen wurde. Sie mit jedem Release mitzuziehen, zeigt allen denselben
 * Dialog erneut; ein Bugfix-Release lässt sie deshalb unangetastet. Erst wenn
 * es hier wirklich Neues zu erzählen gibt, werden Text UND Nummer zusammen
 * geändert - dann, und nur dann, geht der Dialog wieder auf.
 */
export const CURRENT_RELEASE: ReleaseInfo = {
	version: "1.1.0",
	title: "Teams",
	summary:
		"Als Chef legst du jetzt Teams an und siehst direkt in TimeTracker, wer seinen Monatsbericht schon abgegeben hat.",
	highlights: [
		{
			icon: "users",
			title: "Teams per Link",
			description:
				"Lege ein Team an und schicke den Beitritts-Link herum. Deine Mitarbeiter brauchen dafür kein eigenes Konto."
		},
		{
			icon: "database",
			title: "Berichte direkt in der App",
			description:
				"Wer im Team seinen Monatsbericht sendet, erscheint sofort bei dir – samt Stunden je Aktivität. Fehlende erinnerst du gesammelt. Die Prüfung des Outlook-Posteingangs entfällt dafür."
		},
		{
			icon: "sparkles",
			title: "Gemeinsame Aktivitäten",
			description:
				"Lege eine Aktivitätenliste für das ganze Team fest. Sie erscheint bei allen, und eigene doppelte Aktivitäten lassen sich damit zusammenführen, ohne dass Stunden verloren gehen."
		},
		{
			icon: "shield",
			title: "Verwalter und Vertretung",
			description:
				"Lade Verwalter ein, die das Team mit dir betreuen, oder übergib die Chef-Rolle, wenn jemand anderes das Team übernimmt."
		}
	]
};

/** Ist `seen` mindestens `wanted`? Vorabfassungen zählen wie die Fassung selbst. */
function isAtLeast(seen: string, wanted: string): boolean {
	const parts = (v: string) => v.split("-")[0].split(".").map((n) => Number(n) || 0);
	const a = parts(seen);
	const b = parts(wanted);
	for (let i = 0; i < 3; i++) {
		const x = a[i] ?? 0;
		const y = b[i] ?? 0;
		if (x !== y) return x > y;
	}
	return true;
}

class WhatsNewState {
	isOpen = $state(false);

	/** Prüfen, ob nach einem Update das Info-Modal automatisch gezeigt werden soll (nur in der Desktop-App). */
	checkOnStartup(isFirstAppStart = false): void {
		// Nur in der Desktop-App (Tauri), nicht im Web-Browser / auf dem Server
		if (!isTauri()) return;
		if (typeof localStorage === "undefined") return;
		// Bei einer komplett frischen Erstinstallation zeigen wir das reguläre Onboarding, kein Update-Modal
		if (isFirstAppStart) {
			this.markAsSeen();
			return;
		}

		try {
			const lastSeen = localStorage.getItem(STORAGE_KEY);
			// Verglichen wird der RANG, nicht die Gleichheit: wer schon eine spätere
			// Fassung gesehen hat, kennt diesen Inhalt. Mit "!==" bekäme jeder den
			// Dialog erneut, sobald die Nummer hier einmal zurückgesetzt wird.
			if (!(lastSeen && isAtLeast(lastSeen, CURRENT_RELEASE.version))) {
				// Kurz verzögert öffnen, damit die App fertig geladen hat
				setTimeout(() => {
					this.isOpen = true;
				}, 600);
			}
		} catch {
			/* localStorage nicht zugänglich */
		}
	}

	markAsSeen(): void {
		this.isOpen = false;
		if (typeof localStorage === "undefined") return;
		try {
			localStorage.setItem(STORAGE_KEY, CURRENT_RELEASE.version);
		} catch {
			/* ignoriere storage Fehler */
		}
	}

	open(): void {
		this.isOpen = true;
	}
}

export const whatsNew = new WhatsNewState();
