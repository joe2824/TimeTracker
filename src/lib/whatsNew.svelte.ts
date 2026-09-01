// Verwaltung des „Was ist neu"-Dialogs für Haupt-Releases.
import { isTauri } from "./platform/env";

const STORAGE_KEY = "timetracker:last_seen_release";

export interface ReleaseHighlight {
	icon: "cloud" | "shield" | "key" | "database" | "sparkles";
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
 * Dialog erneut; ein Bugfix-Release laesst sie deshalb unangetastet. Erst wenn
 * es hier wirklich Neues zu erzaehlen gibt, werden Text UND Nummer zusammen
 * geaendert - dann, und nur dann, geht der Dialog wieder auf.
 */
export const CURRENT_RELEASE: ReleaseInfo = {
	version: "0.9.0",
	title: "Multi-Geräte-Synchronisation",
	summary: "TimeTracker synchronisiert deine Arbeitszeiten ab sofort nahtlos und sicher zwischen all deinen Geräten.",
	highlights: [
		{
			icon: "cloud",
			title: "Geräte-Synchronisation",
			description: "Erfasse deine Zeiten auf mehreren Computern oder unterwegs im Web – alles wird automatisch abgeglichen."
		},
		{
			icon: "shield",
			title: "Ende-zu-Ende-Verschlüsselung",
			description: "Zero-Knowledge Schutz: Alle Daten werden lokal auf deinem Gerät verschlüsselt. Niemand außer dir kann deine Zeiten einsehen."
		},
		{
			icon: "key",
			title: "Passkeys & einfache Kopplung",
			description: "Passwortlose Anmeldung über dein Gerät oder Passwort-Manager und sekundenschnelle Kopplung per 12-stelligem Code."
		},
		{
			icon: "sparkles",
			title: "Offline-First & Echtzeit",
			description: "Erfasse Zeiten jederzeit auch ohne Internetverbindung – TimeTracker synchronisiert automatisch, sobald du wieder online bist."
		}
	]
};

/** Ist `seen` mindestens `wanted`? Vorabfassungen zaehlen wie die Fassung selbst. */
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
			// Verglichen wird der RANG, nicht die Gleichheit: wer schon eine spaetere
			// Fassung gesehen hat, kennt diesen Inhalt. Mit "!==" bekaeme jeder den
			// Dialog erneut, sobald die Nummer hier einmal zurueckgesetzt wird.
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
