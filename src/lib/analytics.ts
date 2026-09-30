// Anonyme Nutzungszählung für den eigenen TimeTracker-Server.
// Erfasst ausschliesslich: tägliche Aktivität, App-Version und Betriebssystem/Plattform.
// Keine personenbezogenen Daten, keine Zeiteinträge, keine Fehler-Uploads an Fremdanbieter.
//
// Gesendet wird in `account.sendUsagePing()` - der Weg dorthin ist derselbe wie
// bei jedem anderen Serveraufruf und weist sich damit auch genauso aus.

import { isTauri } from "./platform/env";
import { detectOs, type OperatingSystem } from "./platform/os";

/**
 * Ermittelt das Betriebssystem bzw. die Plattform für die Statistik.
 *
 * Die Namen erwartet der Server so (KNOWN_PLATFORMS in server/src/lib/server/stats.ts);
 * Handys zählen als "web", eine eigene Kennung dafür kennt er nicht.
 */
export function detectPlatform(): string {
	if (typeof window === "undefined") return "unknown";
	const os = detectOs();
	if (isTauri()) return os === "windows" || os === "macos" || os === "linux" ? os : "desktop";
	return WEB_PLATFORM[os];
}

const WEB_PLATFORM: Record<OperatingSystem, string> = {
	windows: "web-win",
	macos: "web-mac",
	linux: "web-linux",
	mobil: "web",
	unbekannt: "web"
};

/**
 * Wie eine Tagesmeldung ausgegangen ist.
 *
 * - `sent`: angekommen, der Tag ist erledigt.
 * - `retry`: gerade nicht - kein Netz, Bremse, abgemeldet, Serverfehler.
 * - `declined`: dieser Server will keine Meldung. Nicht wiederholen.
 */
export type PingResult = "sent" | "retry" | "declined";

/**
 * Antwortstatus, nach denen ein zweiter Versuch nichts anderes ergäbe: den
 * Endpunkt gibt es nicht (404/405/410) oder die Herkunft ist abgelehnt (403).
 *
 * 401 gehört NICHT dazu - das heisst auch "gerade abgemeldet", und wer sich
 * wieder anmeldet, soll wieder zählen. Gegen endloses Klopfen steht stattdessen
 * die Versuchsgrenze in `watchers.svelte.ts`.
 */
const DECLINED_STATUS = new Set([403, 404, 405, 410]);

/** Was ein fehlgeschlagener Versuch bedeutet. Status 0 heisst "kein Netz". */
export function classifyPingFailure(status: number): PingResult {
	return DECLINED_STATUS.has(status) ? "declined" : "retry";
}
