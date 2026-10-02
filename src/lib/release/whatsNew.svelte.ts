// Verwaltung des „Was ist neu“-Dialogs für Haupt-Releases.
import { logWarn } from "../log";
import { isTauri } from "../platform/env";
import { loadSeenRelease, saveSeenRelease } from "../store";

/** Nur noch zum Lesen, für Bestandsgeräte - der Vermerk liegt jetzt im Datenordner. */
const LEGACY_STORAGE_KEY = "timetracker:last_seen_release";

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
		"Als Vorgesetzte oder Vorgesetzter legst du jetzt Teams an und siehst direkt in TimeTracker, wer seinen Monatsbericht schon abgegeben hat.",
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
				"Lade Verwalter ein, die das Team mit dir betreuen, oder übergib die Leitung, wenn jemand anderes das Team übernimmt."
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

/** Der Vermerk aus der Zeit, als er nur im localStorage lag. */
function legacySeenRelease(): string | null {
	if (typeof localStorage === "undefined") return null;
	try {
		return localStorage.getItem(LEGACY_STORAGE_KEY);
	} catch {
		return null;
	}
}

class WhatsNewState {
	isOpen = $state(false);

	/** Prüfen, ob nach einem Update das Info-Modal automatisch gezeigt werden soll (nur in der Desktop-App). */
	async checkOnStartup(isFirstAppStart = false): Promise<void> {
		// Nur in der Desktop-App (Tauri), nicht im Web-Browser / auf dem Server
		if (!isTauri()) return;
		// Bei einer komplett frischen Erstinstallation zeigen wir das reguläre Onboarding, kein Update-Modal
		if (isFirstAppStart) {
			await this.markAsSeen();
			return;
		}

		const stored = await loadSeenRelease().catch(() => null);
		const lastSeen = stored ?? legacySeenRelease();
		// Verglichen wird der RANG, nicht die Gleichheit: wer schon eine spätere
		// Fassung gesehen hat, kennt diesen Inhalt. Mit "!==" bekäme jeder den
		// Dialog erneut, sobald die Nummer hier einmal zurückgesetzt wird.
		if (lastSeen && isAtLeast(lastSeen, CURRENT_RELEASE.version)) {
			if (stored === null) await this.remember(lastSeen);
			return;
		}
		// Kurz verzögert öffnen, damit die App fertig geladen hat
		setTimeout(() => {
			this.isOpen = true;
		}, 600);
	}

	async markAsSeen(): Promise<void> {
		this.isOpen = false;
		await this.remember(CURRENT_RELEASE.version);
	}

	private async remember(version: string): Promise<void> {
		try {
			await saveSeenRelease(version);
		} catch (e) {
			logWarn("Vermerk zu „Was ist neu“ nicht gespeichert", e);
		}
	}

	open(): void {
		this.isOpen = true;
	}
}

export const whatsNew = new WhatsNewState();
