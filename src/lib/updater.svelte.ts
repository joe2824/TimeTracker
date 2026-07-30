// Update-Suche und -Installation als gemeinsamer Zustand.
//
// Liegt bewusst NICHT in der Einstellungs-Seite: den Hinweis "Update verfügbar"
// zeigt der Start als Toast, den Dialog braucht aber auch die Einstellungs-Seite.
// Solange beide ihr eigenes `pending` hielten, konnte der Toast-Knopf nur den
// Tab wechseln – dort musste man die Suche von Hand wiederholen, um überhaupt an
// den Installieren-Knopf zu kommen. Ein Zustand, ein Dialog, ein Knopf.
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { toast } from "svelte-sonner";
import { errorText, flushLog, logError, logInfo, logWarn } from "./log";

class UpdaterState {
	/** Gefundenes Update (auch wenn der Dialog gerade zu ist). */
	pending = $state<Update | null>(null);
	/** Dialog sichtbar. */
	open = $state(false);
	checking = $state(false);
	installing = $state(false);
	/** 0..100, -1 = unbestimmt (Server nennt keine Größe). */
	progress = $state(0);
	downloaded = $state(0);
	totalBytes = $state(0);
}
export const updater = new UpdaterState();

/**
 * Nach einem Update suchen.
 *
 * `silent`: nur merken und protokollieren, nichts anzeigen – für den Start, der
 * seinen eigenen Toast setzt. Sonst meldet die Funktion selbst, was sie fand.
 *
 * @returns true = ein Update liegt bereit
 */
export async function checkForUpdate({ silent = false } = {}): Promise<boolean> {
	updater.checking = true;
	try {
		const update = await check();
		updater.pending = update;
		logInfo(update ? `Update ${update.version} gefunden` : "Kein Update verfügbar");
		if (update) {
			if (!silent) updater.open = true;
			return true;
		}
		if (!silent) toast.success("Du bist auf dem neuesten Stand.");
		return false;
	} catch (e) {
		// Offline oder Updater nicht konfiguriert – beim stillen Lauf kein Fall für
		// den Benutzer, der Grund gehört aber ins Protokoll.
		if (silent) {
			logWarn("Update-Prüfung beim Start nicht möglich", e);
		} else {
			logError("Update-Prüfung fehlgeschlagen", e);
			toast.error(`Update-Prüfung nicht möglich: ${errorText(e)}`);
		}
		return false;
	} finally {
		updater.checking = false;
	}
}

/**
 * Den Dialog zu einem bereits gefundenen Update öffnen; ist keins gemerkt (z.B.
 * nach einem `reload()` der Seite), wird erneut gesucht. Ohne dieses Nachfassen
 * führte der Knopf im Hinweis-Toast ins Leere.
 */
export async function openUpdateDialog(): Promise<void> {
	if (updater.pending) {
		updater.open = true;
		return;
	}
	await checkForUpdate();
}

export async function installUpdate(): Promise<void> {
	const update = updater.pending;
	if (!update) return;
	updater.installing = true;
	updater.progress = -1;
	updater.downloaded = 0;
	updater.totalBytes = 0;
	// Vor dem Neustart schreiben: was hier schiefgeht, sieht danach niemand mehr –
	// genau die Luecke, in der die App nach einem Update seltsam dastand.
	logInfo(`Update ${update.version} wird installiert`);
	try {
		await update.downloadAndInstall((event) => {
			if (event.event === "Started") {
				updater.totalBytes = event.data.contentLength ?? 0;
				updater.progress = updater.totalBytes ? 0 : -1;
			} else if (event.event === "Progress") {
				updater.downloaded += event.data.chunkLength;
				if (updater.totalBytes) {
					updater.progress = Math.round((updater.downloaded / updater.totalBytes) * 100);
				}
			} else if (event.event === "Finished") {
				updater.progress = 100;
			}
		});
		logInfo(`Update ${update.version} installiert, App startet neu`);
		toast.success("Update installiert – App wird neu gestartet.");
		await flushLog(); // der Neustart wartet auf niemanden
		await relaunch();
	} catch (e) {
		logError("Update fehlgeschlagen", e);
		toast.error(`Update fehlgeschlagen: ${errorText(e)}`, { duration: 60000 });
		updater.installing = false;
	}
}
