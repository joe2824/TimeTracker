// Update-Suche und -Installation als gemeinsamer Zustand.
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { toast } from "svelte-sonner";
import { errorText, flushLog, logDebug, logError, logInfo, logWarn } from "../log";

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

/** Ob die letzte stille Suche schon gescheitert ist. */
let silentFailureLogged = false;
/** Version des zuletzt protokollierten Fundes, um stündliche Wiederholungen zu vermeiden. */
let lastLoggedFoundVersion: string | null = null;

/**
 * Nach einem Update suchen.
 *
 * @returns true = ein Update liegt bereit
 */
export async function checkForUpdate({ silent = false } = {}): Promise<boolean> {
	updater.checking = true;
	try {
		const update = await check();
		updater.pending = update;
		silentFailureLogged = false;
		if (update) {
			if (!silent || lastLoggedFoundVersion !== update.version) {
				logInfo(`Update ${update.version} gefunden`);
				lastLoggedFoundVersion = update.version;
			} else {
				logDebug(`Update ${update.version} weiterhin verfügbar`);
			}
			if (!silent) updater.open = true;
			return true;
		}
		lastLoggedFoundVersion = null;
		// Im Hintergrund nur als Debug-Zeile: als Info stünde dieselbe Meldung
		// 24-mal am Tag im Protokoll und verdeckte, was dort wirklich passiert ist.
		if (silent) {
			logDebug("Kein Update verfügbar");
		} else {
			logInfo("Kein Update verfügbar");
			toast.success("Du bist auf dem neuesten Stand.");
		}
		return false;
	} catch (e) {

		// Offline oder Updater nicht konfiguriert – beim stillen Lauf kein Fall für
		// den Benutzer, der Grund gehört aber ins Protokoll. Einmal je Ausfall:
		// die nächste erfolgreiche Suche setzt die Wache zurück.
		if (silent) {
			const msg = String(e instanceof Error ? e.message : e);
			const isPlatformMismatch = msg.includes("fallback platforms") || msg.includes("platforms");
			if (!silentFailureLogged && !isPlatformMismatch) {
				silentFailureLogged = true;
				logWarn("Update-Prüfung im Hintergrund nicht möglich (z.B. kein Netz)", e);
			} else if (isPlatformMismatch) {
				logDebug("Kein passendes Update-Paket für dieses Betriebssystem in Release-Feed");
			}
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
	// Vor dem Neustart schreiben: was hier schiefgeht, sieht danach niemand mehr.
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
