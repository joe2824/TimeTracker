// Anonyme Nutzungszaehlung fuer den eigenen TimeTracker-Server.
// Erfasst ausschliesslich: taegliche Aktivitaet, App-Version und Betriebssystem/Plattform.
// Keine personenbezogenen Daten, keine Zeiteintraege, keine Fehler-Uploads an Fremdanbieter.
import { APP_VERSION, TELEMETRY_KEY } from "./defaults";
import { deviceId as getDeviceId } from "./sync/device";
import { platformFetch } from "./platform/http";
import { isTauri } from "./platform/env";

/**
 * Ermittelt das Betriebssystem bzw. die Plattform fuer die Statistik.
 */
export function detectPlatform(): string {
	if (typeof window === "undefined") return "unknown";
	const inTauri = "__TAURI_INTERNALS__" in window;
	const ua = (navigator.userAgent || "").toLowerCase();
	const plat = ((navigator as any).platform || "").toLowerCase();

	if (inTauri) {
		if (ua.includes("mac") || plat.includes("mac")) return "macos";
		if (ua.includes("win") || plat.includes("win")) return "windows";
		if (ua.includes("linux") || plat.includes("linux")) return "linux";
		return "desktop";
	}

	if (ua.includes("mac") || plat.includes("mac")) return "web-mac";
	if (ua.includes("win") || plat.includes("win")) return "web-win";
	if (ua.includes("linux") || plat.includes("linux")) return "web-linux";
	return "web";
}

/**
 * Wie eine Tagesmeldung ausgegangen ist.
 *
 * - `sent`: angekommen, der Tag ist erledigt.
 * - `retry`: gerade nicht - kein Netz, Bremse, Serverfehler. Spaeter nochmal.
 * - `declined`: dieser Server will keine Meldung. Nicht wiederholen.
 */
export type PingResult = "sent" | "retry" | "declined";

/**
 * Antwortstatus, nach denen ein zweiter Versuch nichts anderes ergaebe: den
 * Endpunkt gibt es nicht (404/405/410) oder die Herkunft ist abgelehnt (403).
 *
 * 401 gehoert NICHT dazu: seit die PWA sich mit ihrer Sitzung ausweist, heisst
 * das auch "gerade abgemeldet" - und wer sich wieder anmeldet, soll wieder
 * zaehlen.
 */
const DECLINED_STATUS = new Set([403, 404, 405, 410]);

/**
 * Meldet diesem Server einmal, dass die Anwendung heute lief. Wirft nie.
 *
 * Die Adresse kommt vom Aufrufer und nicht aus `account`: sonst haengt dieses
 * Modul am ganzen Abgleich-Stapel, und ueber `log.ts` haenge daran fast alle
 * anderen.
 *
 * `platformFetch` und nicht `globalThis.fetch`: das Fenster der
 * Desktop-Anwendung hat die Herkunft `tauri://localhost`, der Ping waere damit
 * CORS-pflichtig und kaeme nie an.
 *
 * Ausgewiesen wird sich mit dem Schluessel aus dem Build ODER - wenn keiner
 * eingesetzt wurde, wie in der PWA - mit der laufenden Sitzung. Passt weder das
 * eine noch das andere, antwortet der Server 401 und es bleibt bei diesem einen
 * Versuch.
 */
export async function sendDailyTelemetryPing(serverUrl: string): Promise<PingResult> {
	// In der Desktop-Huelle gibt es keine Sitzung, die den Schluessel ersetzen
	// koennte. Ohne ihn hat die Meldung keinen Ausweis und braucht gar nicht erst
	// loszulaufen.
	if (!TELEMETRY_KEY && isTauri()) return "declined";
	// Ohne verknuepftes Konto gibt es keinen Server, der zaehlen duerfte. Das kann
	// sich jederzeit aendern, also "spaeter nochmal" und nicht "nie".
	const targetServer = (serverUrl || "").trim().replace(/\/+$/, "");
	if (!targetServer) return "retry";

	try {
		const answer = await platformFetch(`${targetServer}/api/telemetry`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				...(TELEMETRY_KEY ? { "x-telemetry-key": TELEMETRY_KEY } : {})
			},
			// Die PWA hat keinen Schluessel - sie liegt im Abbild, und das ist fuer
			// alle Betreiber dasselbe. Sie weist sich stattdessen mit ihrer Sitzung
			// aus; der Server nimmt beides. Nur im Browser: in der Desktop-Huelle
			// geht der Aufruf durch das HTTP-Plugin, das mit dem Feld nichts anfangen
			// kann.
			...(isTauri() ? {} : { credentials: "include" as const }),
			body: JSON.stringify({
				deviceId: await getDeviceId(),
				version: APP_VERSION,
				platform: detectPlatform()
			})
		});
		if (answer.ok) return "sent";
		// Ein Server ohne TELEMETRY_KEY antwortet dauerhaft mit 404. Wer das als
		// "spaeter nochmal" liest, klopft bis in alle Ewigkeit an - und bringt
		// hinter einer gemeinsamen Adresse irgendwann die Bremse zum Anschlagen.
		return DECLINED_STATUS.has(answer.status) ? "declined" : "retry";
	} catch {
		// Kein Netz, kein Server erreichbar: das kann morgen anders sein.
		return "retry";
	}
}
