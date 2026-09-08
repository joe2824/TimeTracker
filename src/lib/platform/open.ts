// Etwas ausserhalb der Anwendung öffnen.
import { isTauri } from "./env";

/** Eine Adresse öffnen. Über Tauri, wo es geht - `openUrl` wirft im Browser. */
export async function openExternal(url: string): Promise<void> {
	if (isTauri()) {
		const { openUrl } = await import("@tauri-apps/plugin-opener");
		await openUrl(url);
		return;
	}
	// mailto und Konsorten kommen über `location` sicherer heraus: ein Popup
	// dafür wird von den meisten Browsern blockiert, weil es keine Seite öffnet.
	if (url.startsWith("mailto:")) {
		window.location.href = url;
		return;
	}
	window.open(url, "_blank", "noopener,noreferrer");
}

/** Einen Ordner im Dateiverwalter zeigen. */
export async function revealInFolder(path: string): Promise<void> {
	if (!isTauri()) throw new Error("Im Browser gibt es keinen Datenordner");
	const { revealItemInDir } = await import("@tauri-apps/plugin-opener");
	await revealItemInDir(path);
}
