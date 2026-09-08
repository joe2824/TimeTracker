// Die zuletzt benutzte Serveradresse - damit sie niemand zweimal eintippt.
//
// Onboarding und Konto-Bereich merkten sie sich unter verschiedenen Schlüsseln
// und lasen den jeweils anderen nie. Wer sie im Assistenten eingegeben hatte,
// fand das Feld in den Einstellungen trotzdem leer.

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
