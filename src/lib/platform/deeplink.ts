// Links, die die Anwendung öffnen.
import { isTauri } from "./env";

/** Das Schema gehört zu tauri.conf.json - beide müssen zusammenpassen. */
export const SCHEMA = "timetracker";

/** Der Link, der die Anwendung mit einem Kopplungscode öffnet. */
export function pairLink(code: string): string {
	return `${SCHEMA}://pair/${encodeURIComponent(code)}`;
}

/** Ein Link kommt von außen: ein kaputtes Escape darf den Listener nicht zum Werfen bringen. */
function decodeSegment(segment: string): string | null {
	try {
		return decodeURIComponent(segment);
	} catch {
		return null;
	}
}

/**
 * Den Kopplungscode aus einem Link ziehen - oder null.
 *
 * Bewusst nachsichtig gegenüber der Form: je nach Betriebssystem kommt
 * "timetracker://pair/ABC" oder "timetracker://pair/ABC/" an.
 */
export function pairCodeFrom(url: string): string | null {
	const hit = /^timetracker:\/\/pair\/([^/?#]+)/i.exec(url.trim());
	return hit ? decodeSegment(hit[1]) : null;
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
 * Der Link, der die Anwendung mit einem Team-Beitrittscode öffnet.
 *
 * Getrennt vom Kopplungslink: ein Team-Mitglied hat kein Konto - anders als
 * beim Kopplungscode kann die Anwendung den Server also aus keinem
 * bestehenden Zustand erschliessen. Er muss deshalb, anders als bei
 * `pairLink`, MIT in den Link.
 */
export function teamJoinLink(serverUrl: string, code: string): string {
	return `${SCHEMA}://team/join/${encodeURIComponent(code)}?server=${encodeURIComponent(serverUrl)}`;
}

/** Beitrittscode und Serveradresse aus einem Team-Link ziehen - oder null. */
export function teamJoinFrom(url: string): { code: string; serverUrl: string } | null {
	const hit = /^timetracker:\/\/team\/join\/([^/?#]+)\/?(?:\?(.*))?$/i.exec(url.trim());
	if (!hit) return null;
	const server = new URLSearchParams(hit[2] ?? "").get("server")?.trim();
	if (!server) return null;
	const code = decodeSegment(hit[1]);
	return code === null ? null : { code, serverUrl: server };
}

/**
 * Auf Links horchen - die drei Wege, über die eine Adresse hereinkommen kann.
 *
 * Ein Kaltstart bringt sie als Startargument mit, eine laufende Anwendung
 * bekommt sie über das Plugin, und unter Windows startet der Link eine zweite
 * Instanz - deren Argumente reicht lib.rs als Ereignis herein. Gemeinsam für
 * jede Art von Link, damit die Plugin-/Ereignis-Anbindung nur einmal steht.
 */
async function listenDeepLinks(onUrl: (url: string) => void): Promise<() => void> {
	if (!isTauri()) return () => {};
	const logout: (() => void)[] = [];
	try {
		const { getCurrent, onOpenUrl } = await import("@tauri-apps/plugin-deep-link");
		for (const url of (await getCurrent()) ?? []) onUrl(url);
		logout.push(await onOpenUrl((urls) => urls.forEach(onUrl)));
	} catch {
		// Ohne Plugin bleibt der Weg über das Ereignis unten.
	}
	try {
		const { listen } = await import("@tauri-apps/api/event");
		logout.push(await listen<string>("deep-link", (e) => onUrl(String(e.payload ?? ""))));
	} catch {
		/* kein Ereigniskanal */
	}
	return () => logout.forEach((f) => f());
}

/**
 * Auf Kopplungs-Links horchen. Gibt eine Funktion zum Abmelden zurück.
 *
 * `alreadyHandled` bekommt die Adresse mit einem Präfix - onPairLink und
 * onTeamJoinLink hören unabhängig voneinander auf jede eingehende Adresse
 * (auch auf eine, die gar nicht zu ihnen gehört) und teilten sich sonst EIN
 * Gedächtnis: eine Team-Adresse, die zuerst hier ankommt, würde als
 * "abgearbeitet" markiert, obwohl hier nichts damit passiert - onTeamJoinLink
 * sähe sie danach nie.
 */
export function onPairLink(
	fn: (code: string) => void,
	onStart?: (serverUrl: string) => void
): Promise<() => void> {
	return listenDeepLinks((url) => {
		if (alreadyHandled(`pair:${url}`)) return;
		const code = pairCodeFrom(url);
		if (code) {
			fn(code);
			return;
		}
		const server = pairStartFrom(url);
		if (server && onStart) onStart(server);
	});
}

/** Auf Team-Beitritts-Links horchen. Gibt eine Funktion zum Abmelden zurück. */
export function onTeamJoinLink(fn: (link: { code: string; serverUrl: string }) => void): Promise<() => void> {
	return listenDeepLinks((url) => {
		if (alreadyHandled(`team:${url}`)) return;
		const link = teamJoinFrom(url);
		if (link) fn(link);
	});
}
