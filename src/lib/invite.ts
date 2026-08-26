// Was ein Link an die Anmeldeseite mitbringen kann.
//
// Ein Code ist vier Gruppen zu vier Zeichen - abtippbar, aber laestig. Ein Link
// nimmt jemandem den Schritt ab und traegt ausserdem die Adresse des Servers,
// die er sonst auch noch erfragen muesste.

export const INVITE_PARAM = "invite";
/** Direkt zum Anlegen springen, statt die Auswahl zu zeigen. */
export const NEU_PARAM = "neu";
/** Der Kopplungscode des Rechners, der diesen Link geoeffnet hat. */
export const PAIR_PARAM = "pair";

/** Der Link, der die Anmeldeseite mit vorbereitetem Code oeffnet. */
export function inviteLink(baseUrl: string, code: string): string {
	return mitParametern(baseUrl, { [INVITE_PARAM]: code });
}

/**
 * Der Link, den die Desktop-Anwendung oeffnet: gleich zum Anlegen, und mit dem
 * eigenen Kopplungscode im Gepaeck, damit danach niemand mehr etwas abtippt.
 */
export function anlegenLink(baseUrl: string, pairCode?: string): string {
	return mitParametern(baseUrl, {
		[NEU_PARAM]: "1",
		...(pairCode ? { [PAIR_PARAM]: pairCode } : {})
	});
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
export function linkParameter(): { invite: string; neu: boolean; pair: string } {
	if (typeof location === "undefined") return { invite: "", neu: false, pair: "" };
	const url = new URL(location.href);
	const lies = (name: string) => {
		const wert = url.searchParams.get(name)?.trim() ?? "";
		if (wert) url.searchParams.delete(name);
		return wert;
	};
	const invite = lies(INVITE_PARAM);
	const neu = lies(NEU_PARAM) !== "";
	const pair = lies(PAIR_PARAM);

	if (invite || neu || pair) {
		try {
			history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
		} catch {
			// Ohne Chronik-Zugriff bleiben sie sichtbar. Unschoen, aber kein Grund,
			// die Anmeldung daran scheitern zu lassen.
		}
	}
	return { invite, neu, pair };
}
