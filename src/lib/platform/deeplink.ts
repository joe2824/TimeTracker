// Links, die die Anwendung öffnen.
import { isTauri } from "./env";

/** Das Schema gehört zu tauri.conf.json - beide müssen zusammenpassen. */
export const SCHEMA = "timetracker";

/** Der Link, der die Anwendung mit einem Kopplungscode öffnet. */
export function pairLink(code: string): string {
	return `${SCHEMA}://pair/${encodeURIComponent(code)}`;
}

/**
 * Den Kopplungscode aus einem Link ziehen - oder null.
 *
 * Bewusst nachsichtig gegenüber der Form: je nach Betriebssystem kommt
 * "timetracker://pair/ABC" oder "timetracker://pair/ABC/" an.
 */
export function pairCodeFrom(url: string): string | null {
	const hit = /^timetracker:\/\/pair\/([^/?#]+)/i.exec(url.trim());
	return hit ? decodeURIComponent(hit[1]) : null;
}

/**
 * Der Link, der die Anwendung auffordert, selbst eine Kopplung zu beginnen.
 *
 * Ohne Code - den kann nur die Anwendung erzeugen: er ist der Abdruck IHRES
 * Geräteschlüssels. Der Browser sagt nur, gegen welchen Server.
 */
export function pairStartLink(serverUrl: string): string {
	return `${SCHEMA}://pair?server=${encodeURIComponent(serverUrl)}`;
}

/** Die Serveradresse aus einem `pair?server=`-Link - oder null. */
export function pairStartFrom(url: string): string | null {
	const hit = /^timetracker:\/\/pair\/?\?(.*)$/i.exec(url.trim());
	if (!hit) return null;
	const server = new URLSearchParams(hit[1]).get("server")?.trim();
	return server || null;
}

/**
 * Schon abgearbeitet?
 *
 * `getCurrent()` gibt die Adresse zurück, mit der die Anwendung gestartet wurde -
 * und zwar bei JEDEM Neuladen der Seite erneut. Ohne dieses Gedächtnis ginge der
 * Kopplungs-Dialog nach jedem Neuladen wieder auf, obwohl er längst beantwortet
 * ist. `sessionStorage` passt genau: es überlebt das Neuladen und endet mit dem
 * Fenster, also mit dem Start, zu dem die Adresse gehört.
 */
export function alreadyHandled(url: string): boolean {
	const KEY = "timetracker:handled_deeplinks";
	try {
		const seen = JSON.parse(sessionStorage.getItem(KEY) ?? "[]") as string[];
		if (seen.includes(url)) return true;
		sessionStorage.setItem(KEY, JSON.stringify([...seen.slice(-9), url]));
		return false;
	} catch {
		// Ohne sessionStorage lieber einmal zu viel fragen als gar nicht.
		return false;
	}
}

/**
 * Auf Links horchen. Gibt eine Funktion zum Abmelden zurück.
 *
 * Drei Wege, weil die Betriebssysteme sich nicht einig sind: ein Kaltstart
 * bringt die Adresse als Startargument mit, eine laufende Anwendung bekommt sie
 * über das Plugin, und unter Windows startet der Link eine zweite Instanz -
 * deren Argumente reicht lib.rs als Ereignis herein.
 */
export async function onPairLink(
	fn: (code: string) => void,
	onStart?: (serverUrl: string) => void
): Promise<() => void> {
	if (!isTauri()) return () => {};
	const on = (url: string) => {
		if (alreadyHandled(url)) return;
		const code = pairCodeFrom(url);
		if (code) {
			fn(code);
			return;
		}
		const server = pairStartFrom(url);
		if (server && onStart) onStart(server);
	};
	const logout: (() => void)[] = [];
	try {
		const { getCurrent, onOpenUrl } = await import("@tauri-apps/plugin-deep-link");
		for (const url of (await getCurrent()) ?? []) on(url);
		logout.push(await onOpenUrl((urls) => urls.forEach(on)));
	} catch {
		// Ohne Plugin bleibt der Weg über das Ereignis unten.
	}
	try {
		const { listen } = await import("@tauri-apps/api/event");
		logout.push(await listen<string>("deep-link", (e) => on(String(e.payload ?? ""))));
	} catch {
		/* kein Ereigniskanal */
	}
	return () => logout.forEach((f) => f());
}
