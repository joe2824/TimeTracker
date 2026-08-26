// Links, die die Anwendung oeffnen.
import { isTauri } from "./env";

/** Das Schema gehoert zu tauri.conf.json - beide muessen zusammenpassen. */
export const SCHEMA = "timetracker";

/** Der Link, der die Anwendung mit einem Kopplungscode oeffnet. */
export function pairLink(code: string): string {
	return `${SCHEMA}://pair/${encodeURIComponent(code)}`;
}

/**
 * Den Kopplungscode aus einem Link ziehen - oder null.
 *
 * Bewusst nachsichtig gegenueber der Form: je nach Betriebssystem kommt
 * "timetracker://pair/ABC" oder "timetracker://pair/ABC/" an.
 */
export function pairCodeAus(url: string): string | null {
	const treffer = /^timetracker:\/\/pair\/([^/?#]+)/i.exec(url.trim());
	return treffer ? decodeURIComponent(treffer[1]) : null;
}

/**
 * Auf Links horchen. Gibt eine Funktion zum Abmelden zurueck.
 *
 * Drei Wege, weil die Betriebssysteme sich nicht einig sind: ein Kaltstart
 * bringt die Adresse als Startargument mit, eine laufende Anwendung bekommt sie
 * ueber das Plugin, und unter Windows startet der Link eine zweite Instanz -
 * deren Argumente reicht lib.rs als Ereignis herein.
 */
export async function onPairLink(fn: (code: string) => void): Promise<() => void> {
	if (!isTauri()) return () => {};
	const auf = (url: string) => {
		const code = pairCodeAus(url);
		if (code) fn(code);
	};
	const abmelden: (() => void)[] = [];
	try {
		const { getCurrent, onOpenUrl } = await import("@tauri-apps/plugin-deep-link");
		for (const url of (await getCurrent()) ?? []) auf(url);
		abmelden.push(await onOpenUrl((urls) => urls.forEach(auf)));
	} catch {
		// Ohne Plugin bleibt der Weg ueber das Ereignis unten.
	}
	try {
		const { listen } = await import("@tauri-apps/api/event");
		abmelden.push(await listen<string>("deep-link", (e) => auf(String(e.payload ?? ""))));
	} catch {
		/* kein Ereigniskanal */
	}
	return () => abmelden.forEach((f) => f());
}
