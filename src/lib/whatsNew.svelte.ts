// Verwaltung des „Was ist neu"-Dialogs für Haupt-Releases.
import { APP_VERSION } from "./defaults";
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
			// Wenn die aktuelle Release-Version noch nicht gesehen wurde:
			if (lastSeen !== CURRENT_RELEASE.version) {
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
