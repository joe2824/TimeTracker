import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Fassade des Updater-Plugins.
 *
 * `check()` ist der einzige Weg nach draussen; alles darunter (Netz, Signatur,
 * Installation) gehoert dem Plugin. Geprueft wird hier, was die App daraus macht:
 * was sie anzeigt, was sie protokolliert und was sie stillschweigend schluckt.
 */
const plugin = vi.hoisted(() => ({ check: vi.fn(), relaunch: vi.fn() }));
vi.mock("@tauri-apps/plugin-updater", () => ({ check: plugin.check }));
vi.mock("@tauri-apps/plugin-process", () => ({ relaunch: plugin.relaunch }));

const toastMock = vi.hoisted(() => ({
	success: vi.fn(),
	error: vi.fn(),
	info: vi.fn(),
	warning: vi.fn()
}));
vi.mock("svelte-sonner", () => ({ toast: Object.assign(vi.fn(), toastMock) }));

const log = vi.hoisted(() => ({
	logInfo: vi.fn(),
	logWarn: vi.fn(),
	logError: vi.fn(),
	logDebug: vi.fn(),
	flushLog: vi.fn(async () => {}),
	errorText: (e: unknown) => (e instanceof Error ? e.message : String(e))
}));
vi.mock("./log", () => log);

const { checkForUpdate, installUpdate, openUpdateDialog, updater } = await import(
	"./updater.svelte"
);

type UpdateProgress = { event: string; data?: Record<string, number | undefined> };

/** Ein gefundenes Update, dessen Installation die uebergebenen Ereignisse meldet. */
function update(version = "1.2.3", events: UpdateProgress[] = []) {
	return {
		version,
		downloadAndInstall: vi.fn(async (cb: (e: UpdateProgress) => void) => {
			for (const e of events) cb(e);
		})
	};
}

beforeEach(async () => {
	// `silentFailureLogged` lebt am Modul und traegt aus dem vorigen Test herueber.
	// Zurueckgesetzt wird er nur von einer gelungenen Suche – also einmal eine
	// laufen lassen, sonst haengt jeder Test daran, was der vorige getan hat.
	plugin.check.mockResolvedValue(null);
	await checkForUpdate({ silent: true });

	vi.clearAllMocks();
	updater.pending = null;
	updater.open = false;
	updater.checking = false;
	updater.installing = false;
	updater.progress = 0;
	updater.downloaded = 0;
	updater.totalBytes = 0;
});

describe("checkForUpdate", () => {
	it("merkt ein gefundenes Update und oeffnet den Dialog", async () => {
		const u = update("0.9.1");
		plugin.check.mockResolvedValue(u);

		await expect(checkForUpdate()).resolves.toBe(true);

		expect(updater.pending).toBe(u);
		expect(updater.open).toBe(true);
		expect(updater.checking).toBe(false);
	});

	it("oeffnet bei der stillen Suche keinen Dialog", async () => {
		plugin.check.mockResolvedValue(update("0.9.1"));

		await checkForUpdate({ silent: true });

		expect(updater.pending).not.toBeNull();
		expect(updater.open).toBe(false);
	});

	it("meldet „aktuell“ nur, wenn der Benutzer selbst gesucht hat", async () => {
		plugin.check.mockResolvedValue(null);

		await expect(checkForUpdate()).resolves.toBe(false);
		expect(toastMock.success).toHaveBeenCalledTimes(1);

		toastMock.success.mockClear();
		await checkForUpdate({ silent: true });
		expect(toastMock.success).not.toHaveBeenCalled();
	});

	it("zeigt einen Fehler der angestossenen Suche an", async () => {
		plugin.check.mockRejectedValue(new Error("kein Netz"));

		await expect(checkForUpdate()).resolves.toBe(false);

		expect(toastMock.error).toHaveBeenCalled();
		expect(log.logError).toHaveBeenCalled();
		expect(updater.checking).toBe(false);
	});

	it("schreibt einen wiederkehrenden Ausfall im Hintergrund nur einmal ins Protokoll", async () => {
		// Die Suche laeuft stuendlich. Ohne diese Wache stuende eine Woche ohne Netz
		// als stuendliche Warnung im Protokoll – und zwar in genau der Ansicht, die
		// nur Probleme zeigen soll.
		plugin.check.mockRejectedValue(new Error("kein Netz"));

		await checkForUpdate({ silent: true });
		await checkForUpdate({ silent: true });
		await checkForUpdate({ silent: true });

		expect(log.logWarn).toHaveBeenCalledTimes(1);
		expect(toastMock.error).not.toHaveBeenCalled();
	});

	it("meldet den naechsten Ausfall wieder, wenn dazwischen eine Suche geklappt hat", async () => {
		plugin.check.mockRejectedValue(new Error("kein Netz"));
		await checkForUpdate({ silent: true });
		expect(log.logWarn).toHaveBeenCalledTimes(1);

		// Eine gelungene Suche stellt die Meldung wieder scharf.
		plugin.check.mockResolvedValue(null);
		await checkForUpdate({ silent: true });

		plugin.check.mockRejectedValue(new Error("kein Netz"));
		await checkForUpdate({ silent: true });
		expect(log.logWarn).toHaveBeenCalledTimes(2);
	});
});

describe("openUpdateDialog", () => {
	it("nimmt ein bereits gefundenes Update, ohne erneut zu suchen", async () => {
		updater.pending = update("0.9.1") as never;

		await openUpdateDialog();

		expect(updater.open).toBe(true);
		expect(plugin.check).not.toHaveBeenCalled();
	});

	it("sucht nach, wenn nichts gemerkt ist", async () => {
		// Der Fall nach einem reload() der Seite: der Knopf im Hinweis-Toast fuehrte
		// sonst ins Leere.
		plugin.check.mockResolvedValue(update("0.9.1"));

		await openUpdateDialog();

		expect(plugin.check).toHaveBeenCalledTimes(1);
		expect(updater.open).toBe(true);
	});
});

describe("installUpdate", () => {
	it("rechnet den Fortschritt aus der gemeldeten Groesse", async () => {
		updater.pending = update("0.9.1", [
			{ event: "Started", data: { contentLength: 1000 } },
			{ event: "Progress", data: { chunkLength: 250 } },
			{ event: "Progress", data: { chunkLength: 250 } }
		]) as never;

		await installUpdate();

		expect(updater.downloaded).toBe(500);
		expect(updater.totalBytes).toBe(1000);
		expect(updater.progress).toBe(50);
	});

	it("bleibt unbestimmt, wenn der Server keine Groesse nennt", async () => {
		updater.pending = update("0.9.1", [
			{ event: "Started", data: { contentLength: undefined } },
			{ event: "Progress", data: { chunkLength: 250 } }
		]) as never;

		await installUpdate();

		expect(updater.progress).toBe(-1);
		expect(updater.downloaded).toBe(250);
	});

	it("startet die App nach dem Schreiben des Protokolls neu", async () => {
		updater.pending = update("0.9.1", [{ event: "Finished" }]) as never;

		await installUpdate();

		expect(updater.progress).toBe(100);
		// Erst schreiben, dann neu starten: der Neustart wartet auf niemanden.
		expect(log.flushLog).toHaveBeenCalled();
		expect(plugin.relaunch).toHaveBeenCalled();
		expect(log.flushLog.mock.invocationCallOrder[0]).toBeLessThan(
			plugin.relaunch.mock.invocationCallOrder[0]
		);
	});

	it("gibt den Knopf nach einem Fehlschlag wieder frei", async () => {
		const u = update("0.9.1");
		u.downloadAndInstall.mockRejectedValue(new Error("Signatur passt nicht"));
		updater.pending = u as never;

		await installUpdate();

		expect(updater.installing).toBe(false);
		expect(toastMock.error).toHaveBeenCalled();
		expect(log.logError).toHaveBeenCalled();
		expect(plugin.relaunch).not.toHaveBeenCalled();
	});

	it("tut nichts, wenn gar kein Update gemerkt ist", async () => {
		updater.pending = null;

		await installUpdate();

		expect(updater.installing).toBe(false);
		expect(plugin.relaunch).not.toHaveBeenCalled();
	});
});
