import { beforeEach, describe, expect, it, vi } from "vitest";

// `platformFetch` und nicht `globalThis.fetch`: das Fenster der
// Desktop-Anwendung hat die Herkunft `tauri://localhost`. Ginge der Ping ueber
// das gewoehnliche fetch, scheiterte er dort an der Vorabanfrage - lautlos, weil
// die Funktion jeden Fehler schluckt. Der Test haelt genau das fest.
const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }));

vi.mock("./platform/http", () => ({
	platformFetch: (...args: unknown[]) => fetchMock(...args)
}));
vi.mock("./sync/device", () => ({
	deviceId: () => Promise.resolve("geraet-1234")
}));
vi.mock("./defaults", () => ({
	APP_VERSION: "9.9.9",
	TELEMETRY_KEY: "schluessel-aus-dem-build"
}));

import { sendDailyTelemetryPing } from "./analytics";

/** Die Antwort, die ein Server auf einen angenommenen Ping gibt. */
const ok = () => ({ ok: true, status: 200 });

beforeEach(() => {
	fetchMock.mockReset();
	fetchMock.mockResolvedValue(ok());
});

describe("sendDailyTelemetryPing", () => {
	it("sendet Kennung, Version und Plattform an den angegebenen Server", async () => {
		expect(await sendDailyTelemetryPing("https://tracker.example.de")).toBe(true);

		expect(fetchMock).toHaveBeenCalledTimes(1);
		const [url, init] = fetchMock.mock.calls[0];
		expect(url).toBe("https://tracker.example.de/api/telemetry");
		expect(init.method).toBe("POST");
		expect(init.headers["x-telemetry-key"]).toBe("schluessel-aus-dem-build");
		expect(JSON.parse(init.body)).toEqual({
			deviceId: "geraet-1234",
			version: "9.9.9",
			platform: expect.any(String)
		});
	});

	it("haengt genau einen Schraegstrich an, egal wie die Adresse endet", async () => {
		await sendDailyTelemetryPing("https://tracker.example.de///");
		expect(fetchMock.mock.calls[0][0]).toBe("https://tracker.example.de/api/telemetry");
	});

	it("fragt ohne Server gar nicht erst", async () => {
		expect(await sendDailyTelemetryPing("")).toBe(false);
		expect(await sendDailyTelemetryPing("   ")).toBe(false);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("meldet eine abgewiesene Antwort als Fehlschlag", async () => {
		// 429 von der Bremse: der Tag darf danach NICHT als gemeldet gelten,
		// sonst faellt das Geraet ersatzlos aus der Zaehlung.
		fetchMock.mockResolvedValue({ ok: false, status: 429 });
		expect(await sendDailyTelemetryPing("https://tracker.example.de")).toBe(false);
	});

	it("wirft nicht, wenn gar keine Verbindung zustande kommt", async () => {
		fetchMock.mockRejectedValue(new Error("kein Netz"));
		await expect(sendDailyTelemetryPing("https://tracker.example.de")).resolves.toBe(false);
	});
});

describe("sendDailyTelemetryPing ohne Schluessel", () => {
	it("meldet nichts, wenn der Build keinen Schluessel eingesetzt hat", async () => {
		vi.resetModules();
		vi.doMock("./defaults", () => ({ APP_VERSION: "9.9.9", TELEMETRY_KEY: "" }));
		const { sendDailyTelemetryPing: ohneSchluessel } = await import("./analytics");

		expect(await ohneSchluessel("https://tracker.example.de")).toBe(false);
		expect(fetchMock).not.toHaveBeenCalled();

		vi.doUnmock("./defaults");
		vi.resetModules();
	});
});
