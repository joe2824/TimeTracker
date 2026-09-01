// Anonyme Nutzungszaehlung fuer den eigenen TimeTracker-Server.
// Erfasst ausschliesslich: taegliche Aktivitaet, App-Version und Betriebssystem/Plattform.
// Keine personenbezogenen Daten, keine Zeiteintraege, keine Fehler-Uploads an Fremdanbieter.
import { APP_VERSION, DEFAULT_SERVER } from "./defaults";
import { deviceId as getDeviceId } from "./sync/device";
import { account } from "./sync/account.svelte";

export type TrackProps = Record<string, string | number>;

/** Laenge, ab der eine Meldung im lokalen Protokoll abgeschnitten wird. */
const MAX_LEN = 120;

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
 * Sendet einen anonymen Telemetrie-Ping an den konfigurierten TimeTracker-Server.
 * Wirft nie Fehler.
 */
export async function sendDailyTelemetryPing(serverUrl?: string): Promise<void> {
	const targetServer = (serverUrl || account.serverUrl || DEFAULT_SERVER || "").trim().replace(/\/+$/, "");
	if (!targetServer) return;

	try {
		const deviceId = await getDeviceId();
		const version = APP_VERSION;
		const platform = detectPlatform();

		await fetch(`${targetServer}/api/telemetry`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ deviceId, version, platform })
		});
	} catch {
		// Fehlgeschlagene Zaehlung stoert den Betrieb nicht und wird verworfen.
	}
}

/**
 * Bereinigt Text im lokalen Protokoll um moegliche persönliche Daten wie Pfade und Mailadressen.
 */
export function redact(text: string): string {
	return text
		.replace(/[^\s<>"'(),;]+@[^\s<>"'(),;]+\.[a-z]{2,}/gi, "<mail>")
		.replace(/(?:[a-z]:\\|\\\\)[^\s"'|]*/gi, "<pfad>")
		.replace(/\/[\w.-]+\/[^\s"'|]*/g, "<pfad>")
		.replace(/\d{4,}/g, "<zahl>")
		.slice(0, MAX_LEN);
}

/**
 * Ein Ereignis melden. Leitet "aktiv" an den eigenen Server weiter. Wirft nie.
 */
export async function track(name: string, _props?: TrackProps): Promise<void> {
	if (name === "aktiv") {
		await sendDailyTelemetryPing();
	}
}

/**
 * Fehler-Uploads zu Drittanbietern wurden entfernt. Diese Funktion ist ein No-Op.
 */
export function trackError(_name: string, _props?: TrackProps): Promise<void> {
	return Promise.resolve();
}

/**
 * Schalter-Stub fuer Rueckwaertskompatibilitaet.
 */
export function setErrorReportsEnabled(_on: boolean): void {}
