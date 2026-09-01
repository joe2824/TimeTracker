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
export function pairCodeFrom(url: string): string | null {
	const hit = /^timetracker:\/\/pair\/([^/?#]+)/i.exec(url.trim());
	return hit ? decodeURIComponent(hit[1]) : null;
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
	const on = (url: string) => {
		const code = pairCodeFrom(url);
		if (code) fn(code);
	};
	const logout: (() => void)[] = [];
	try {
		const { getCurrent, onOpenUrl } = await import("@tauri-apps/plugin-deep-link");
		for (const url of (await getCurrent()) ?? []) on(url);
		logout.push(await onOpenUrl((urls) => urls.forEach(on)));
	} catch {
		// Ohne Plugin bleibt der Weg ueber das Ereignis unten.
	}
	try {
		const { listen } = await import("@tauri-apps/api/event");
		logout.push(await listen<string>("deep-link", (e) => on(String(e.payload ?? ""))));
	} catch {
		/* kein Ereigniskanal */
	}
	return () => logout.forEach((f) => f());
}
