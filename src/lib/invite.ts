// Was ein Link an die Anmeldeseite mitbringen kann.
//
// Ein Code ist vier Gruppen zu vier Zeichen - abtippbar, aber laestig. Ein Link
// nimmt jemandem den Schritt ab und traegt ausserdem die Adresse des Servers,
// die er sonst auch noch erfragen muesste.

export const INVITE_PARAM = "invite";
/** Direkt zum Anlegen springen, statt die Auswahl zu zeigen. */
export const NEW_PARAM = "neu";

/** Der Link, der die Anmeldeseite mit vorbereitetem Code oeffnet. */
export function inviteLink(baseUrl: string, code: string): string {
	return withParams(baseUrl, { [INVITE_PARAM]: code });
}

/**
 * Der Link, den die Desktop-Anwendung oeffnet: gleich zum Anlegen.
 *
 * Der Kopplungscode reist bewusst NICHT mit. Er ist der Abdruck des
 * Geraeteschluessels und der einzige Anhaltspunkt, an dem ein Mensch "mein
 * Rechner" von "ein untergeschobener Vorgang" unterscheiden kann. In einer
 * Adresse landete er in der Chronik, in Bildschirmfotos und im Verlauf des
 * Browsers - und der Vergleich waere zur Formsache geworden, weil der Code schon
 * im Feld stand. Er steht jetzt nur auf dem Rechner und wird abgetippt.
 */
export function createLink(baseUrl: string): string {
	return withParams(baseUrl, { [NEW_PARAM]: "1" });
}

function withParams(baseUrl: string, values: Record<string, string>): string {
	const url = new URL(baseUrl.replace(/\/+$/, "") || "/", "http://ungenutzt");
	for (const [k, v] of Object.entries(values)) url.searchParams.set(k, v);
	return baseUrl ? url.toString() : `${url.pathname}${url.search}`;
}

/**
 * Die Parameter aus der aktuellen Adresse holen - und die Adresse saeubern.
 *
 * Beides sind Einmalwerte. In der Adresszeile stehen zu bleiben hilft niemandem:
 * sie landeten in der Chronik, in geteilten Bildschirmfotos und im naechsten
 * Neuladen, wo sie dann nicht mehr gelten und wie ein Fehler aussehen.
 */
export function linkParameter(): { invite: string; fresh: boolean } {
	if (typeof location === "undefined") return { invite: "", fresh: false };
	const url = new URL(location.href);
	const readIt = (name: string) => {
		const value = url.searchParams.get(name)?.trim() ?? "";
		if (value) url.searchParams.delete(name);
		return value;
	};
	const invite = readIt(INVITE_PARAM);
	const fresh = readIt(NEW_PARAM) !== "";

	if (invite || fresh) {
		try {
			history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
		} catch {
			// Ohne Chronik-Zugriff bleiben sie sichtbar. Unschoen, aber kein Grund,
			// die Anmeldung daran scheitern zu lassen.
		}
	}
	return { invite, fresh };
}
