// Die Tagesmeldung einer Installation, die noch kein Konto verknuepft hat.
//
// Mit Konto laeuft sie ueber `#api` und weist sich wie jeder andere Aufruf aus.
// Ohne Konto gibt es kein `#api` - dann ist der Schluessel aus dem Build der
// einzige Ausweis, und ohne ihn wird gar nicht erst gefragt.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-fs", async () => (await import("../testing/fakeFs")).fakeFs);
vi.mock("svelte-sonner", () => import("../testing/toastStub"));

const build = vi.hoisted(() => ({ server: "https://tracker.example.de", key: "schluessel" }));
vi.mock("../defaults", () => ({
	APP_VERSION: "9.9.9",
	get DEFAULT_SERVER() {
		return build.server;
	},
	get TELEMETRY_KEY() {
		return build.key;
	}
}));

const env = vi.hoisted(() => ({ tauri: true }));
vi.mock("../platform/env", () => ({
	isTauri: () => env.tauri,
	capabilities: { notifications: false, tray: false, autostart: false, globalShortcuts: false }
}));

const fetchMock = vi.hoisted(() => vi.fn());
vi.mock("../platform/http", () => ({ platformFetch: fetchMock }));

const { resetFakeFs } = await import("../testing/fakeFs");
const { account } = await import("./account.svelte");

beforeEach(() => {
	resetFakeFs();
	build.server = "https://tracker.example.de";
	build.key = "schluessel";
	env.tauri = true;
	account.serverUrl = "";
	fetchMock.mockReset();
	fetchMock.mockResolvedValue(
		new Response(JSON.stringify({ ok: true }), {
			status: 200,
			headers: { "content-type": "application/json" }
		})
	);
});

describe("Tagesmeldung ohne verknuepftes Konto", () => {
	it("meldet an den Server aus dem Build und weist sich mit dem Schluessel aus", async () => {
		expect(account.usagePingServer).toBe("https://tracker.example.de");
		expect(await account.sendUsagePing()).toBe("sent");

		const [url, init] = fetchMock.mock.calls[0];
		expect(url).toBe("https://tracker.example.de/api/telemetry");
		expect(init.headers["x-telemetry-key"]).toBe("schluessel");
		expect(JSON.parse(init.body)).toMatchObject({ version: "9.9.9" });
	});

	// Ohne Schluessel kaeme die Meldung als 401 zurueck. Gar nicht erst zu fragen
	// spart den Fehlversuch, der sonst das Budget der Stunde aufbraucht.
	it("fragt ohne Schluessel im Build gar nicht erst", async () => {
		build.key = "";

		expect(account.usagePingServer).toBe("");
		expect(await account.sendUsagePing()).toBe("retry");
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("fragt ohne eingetragenen Server gar nicht erst", async () => {
		build.server = "";

		expect(account.usagePingServer).toBe("");
		expect(fetchMock).not.toHaveBeenCalled();
	});

	// Im Browser gibt es diesen Weg nicht: der Schluessel liegt nicht im
	// Web-Bundle, und wer angemeldet ist, zaehlt ohnehin ueber seine Sitzung.
	it("gibt es im Browser nicht", async () => {
		env.tauri = false;

		expect(account.usagePingServer).toBe("");
		expect(await account.sendUsagePing()).toBe("retry");
		expect(fetchMock).not.toHaveBeenCalled();
	});

	// Der verknuepfte Server sticht den aus dem Build - sonst zaehlte ein Geraet
	// beim Hersteller statt bei dem, mit dem es wirklich arbeitet.
	it("nimmt den verknuepften Server, sobald es einen gibt", () => {
		account.serverUrl = "https://firma.example.de";

		expect(account.usagePingServer).toBe("https://firma.example.de");
	});
});
