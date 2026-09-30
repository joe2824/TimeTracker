// Die zuletzt benutzte Serveradresse - damit sie niemand zweimal eintippt.
import { DEFAULT_SERVER } from "../defaults";

const KEY = "preferred_server_url";
/** Der Schlüssel aus dem Konto-Bereich. Nur noch zum Lesen, für Bestandsgeräte. */
const LEGACY_KEY = "tt_server_url";

export function rememberServerUrl(url: string): void {
	if (typeof localStorage === "undefined") return;
	try {
		localStorage.setItem(KEY, url);
	} catch {
		// Ohne Zugriff auf den Speicher muss die Adresse eben erneut eingetippt
		// werden - kein Grund, das Verknüpfen daran scheitern zu lassen.
	}
}

export function rememberedServerUrl(): string {
	if (typeof localStorage === "undefined") return "";
	try {
		return localStorage.getItem(KEY) || localStorage.getItem(LEGACY_KEY) || "";
	} catch {
		return "";
	}
}

/** Vorbelegung des Adressfelds: verknüpfter Server, zuletzt benutzter, eingebauter. */
export function initialServerUrl(linked: string): string {
	return linked || rememberedServerUrl() || DEFAULT_SERVER || "";
}
