// Anonyme Nutzungszaehlung fuer den eigenen TimeTracker-Server.
// Erfasst ausschliesslich: taegliche Aktivitaet, App-Version und Betriebssystem/Plattform.
// Keine personenbezogenen Daten, keine Zeiteintraege, keine Fehler-Uploads an Fremdanbieter.
import { APP_VERSION, TELEMETRY_KEY } from "./defaults";
import { deviceId as getDeviceId } from "./sync/device";
import { platformFetch } from "./platform/http";

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
 * Meldet diesem Server einmal, dass die Anwendung heute lief. Wirft nie; `false`
 * heisst "nicht angekommen", der Tag bleibt dann offen und wird spaeter erneut
 * versucht.
 *
 * Die Adresse kommt vom Aufrufer und nicht aus `account`: sonst haengt dieses
 * Modul am ganzen Abgleich-Stapel, und ueber `log.ts` haenge daran fast alle
 * anderen.
 *
 * `platformFetch` und nicht `globalThis.fetch`: das Fenster der
 * Desktop-Anwendung hat die Herkunft `tauri://localhost`, der Ping waere damit
 * CORS-pflichtig und kaeme nie an.
 */
export async function sendDailyTelemetryPing(serverUrl: string): Promise<boolean> {
	const targetServer = (serverUrl || "").trim().replace(/\/+$/, "");
	// Ohne eigenen Server gibt es niemanden, der zaehlen duerfte. Ohne Schluessel
	// weist der Server den Ping ohnehin ab - dann gar nicht erst fragen.
	if (!targetServer || !TELEMETRY_KEY) return false;

	try {
		const answer = await platformFetch(`${targetServer}/api/telemetry`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-telemetry-key": TELEMETRY_KEY
			},
			body: JSON.stringify({
				deviceId: await getDeviceId(),
				version: APP_VERSION,
				platform: detectPlatform()
			})
		});
		return answer.ok;
	} catch {
		// Kein Netz, kein Server, abgewiesen - alles derselbe Fall: nicht gezaehlt.
		return false;
	}
}
