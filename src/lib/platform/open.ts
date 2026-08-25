// Etwas ausserhalb der Anwendung oeffnen.
//
// Auf dem Rechner uebernimmt das Betriebssystem ueber Tauri, im Browser der
// Browser selbst. Der Unterschied ist klein, aber `openUrl` aus dem Tauri-Plugin
// wirft im Browser - und ausgerechnet an einem "E-Mail vorbereiten" darf nichts
// scheitern, was der Browser von Haus aus kann.
import { isTauri } from "./env";

/**
 * Eine Adresse oeffnen - eine Webseite oder ein mailto-Link.
 *
 * `noopener` ist Absicht: ohne das bekommt die geoeffnete Seite einen Verweis
 * auf unser Fenster und kann es umleiten.
 */
export async function openExternal(url: string): Promise<void> {
	if (isTauri()) {
		const { openUrl } = await import("@tauri-apps/plugin-opener");
		await openUrl(url);
		return;
	}
	// mailto und Konsorten kommen ueber `location` sicherer heraus: ein Popup
	// dafuer wird von den meisten Browsern blockiert, weil es keine Seite oeffnet.
	if (url.startsWith("mailto:")) {
		window.location.href = url;
		return;
	}
	window.open(url, "_blank", "noopener,noreferrer");
}

/**
 * Einen Ordner im Dateiverwalter zeigen.
 *
 * Gibt es im Browser nicht - dort liegt nichts in einem Ordner. Der Aufrufer
 * fragt vorher ueber `capabilities`, statt hier auf einen Fehler zu warten.
 */
export async function revealInFolder(path: string): Promise<void> {
	if (!isTauri()) throw new Error("Im Browser gibt es keinen Datenordner");
	const { revealItemInDir } = await import("@tauri-apps/plugin-opener");
	await revealItemInDir(path);
}
