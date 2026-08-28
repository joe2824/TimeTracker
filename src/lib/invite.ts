// Was ein Link an die Anmeldeseite mitbringen kann.
//
// Ein Code ist vier Gruppen zu vier Zeichen - abtippbar, aber laestig. Ein Link
// nimmt jemandem den Schritt ab und traegt ausserdem die Adresse des Servers,
// die er sonst auch noch erfragen muesste.

export const INVITE_PARAM = "invite";
/** Direkt zum Anlegen springen, statt die Auswahl zu zeigen. */
export const NEU_PARAM = "neu";

/** Der Link, der die Anmeldeseite mit vorbereitetem Code oeffnet. */
export function inviteLink(baseUrl: string, code: string): string {
	return mitParametern(baseUrl, { [INVITE_PARAM]: code });
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
export function anlegenLink(baseUrl: string): string {
	return mitParametern(baseUrl, { [NEU_PARAM]: "1" });
}

function mitParametern(baseUrl: string, werte: Record<string, string>): string {
	const url = new URL(baseUrl.replace(/\/+$/, "") || "/", "http://ungenutzt");
	for (const [k, v] of Object.entries(werte)) url.searchParams.set(k, v);
	return baseUrl ? url.toString() : `${url.pathname}${url.search}`;
}

/**
 * Die Parameter aus der aktuellen Adresse holen - und die Adresse saeubern.
 *
 * Beides sind Einmalwerte. In der Adresszeile stehen zu bleiben hilft niemandem:
 * sie landeten in der Chronik, in geteilten Bildschirmfotos und im naechsten
 * Neuladen, wo sie dann nicht mehr gelten und wie ein Fehler aussehen.
 */
export function linkParameter(): { invite: string; neu: boolean } {
	if (typeof location === "undefined") return { invite: "", neu: false };
	const url = new URL(location.href);
	const lies = (name: string) => {
		const wert = url.searchParams.get(name)?.trim() ?? "";
		if (wert) url.searchParams.delete(name);
		return wert;
	};
	const invite = lies(INVITE_PARAM);
	const neu = lies(NEU_PARAM) !== "";

	if (invite || neu) {
		try {
			history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
		} catch {
			// Ohne Chronik-Zugriff bleiben sie sichtbar. Unschoen, aber kein Grund,
			// die Anmeldung daran scheitern zu lassen.
		}
	}
	return { invite, neu };
}
