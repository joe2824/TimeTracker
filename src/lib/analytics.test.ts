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
// Im Test gibt es kein Tauri-Fenster: der Zweig ist der der PWA.
vi.mock("./platform/env", () => ({ isTauri: () => false }));

import { sendDailyTelemetryPing } from "./analytics";

/** Die Antwort, die ein Server auf einen angenommenen Ping gibt. */
const ok = () => ({ ok: true, status: 200 });

beforeEach(() => {
	fetchMock.mockReset();
	fetchMock.mockResolvedValue(ok());
});

describe("sendDailyTelemetryPing", () => {
	it("sendet Kennung, Version und Plattform an den angegebenen Server", async () => {
		expect(await sendDailyTelemetryPing("https://tracker.example.de")).toBe("sent");

		expect(fetchMock).toHaveBeenCalledTimes(1);
		const [url, init] = fetchMock.mock.calls[0];
		expect(url).toBe("https://tracker.example.de/api/telemetry");
		expect(init.method).toBe("POST");
		expect(init.headers["x-telemetry-key"]).toBe("schluessel-aus-dem-build");
		expect(init.credentials).toBe("include");
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

	// Ohne verknuepftes Konto gibt es keine Adresse - das kann sich aber jederzeit
	// aendern, also "spaeter nochmal" und nicht "nie".
	it("fragt ohne Server gar nicht erst", async () => {
		expect(await sendDailyTelemetryPing("")).toBe("retry");
		expect(await sendDailyTelemetryPing("   ")).toBe("retry");
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("wiederholt nach einer Bremse oder einem Serverfehler", async () => {
		// 429 von der Bremse: der Tag darf danach NICHT als gemeldet gelten,
		// sonst faellt das Geraet ersatzlos aus der Zaehlung.
		fetchMock.mockResolvedValue({ ok: false, status: 429 });
		expect(await sendDailyTelemetryPing("https://tracker.example.de")).toBe("retry");

		fetchMock.mockResolvedValue({ ok: false, status: 500 });
		expect(await sendDailyTelemetryPing("https://tracker.example.de")).toBe("retry");
	});

	// Ein Server ohne TELEMETRY_KEY antwortet dauerhaft mit 404. Als "spaeter
	// nochmal" gelesen klopfte die Anwendung endlos an.
	it("gibt auf, wenn der Server die Meldung dauerhaft ablehnt", async () => {
		for (const status of [401, 403, 404]) {
			fetchMock.mockResolvedValue({ ok: false, status });
			expect(await sendDailyTelemetryPing("https://tracker.example.de")).toBe("declined");
		}
	});

	it("wirft nicht, wenn gar keine Verbindung zustande kommt", async () => {
		fetchMock.mockRejectedValue(new Error("kein Netz"));
		await expect(sendDailyTelemetryPing("https://tracker.example.de")).resolves.toBe("retry");
	});
});

describe("sendDailyTelemetryPing ohne Schluessel", () => {
	// Die PWA liegt im Server-Abbild, das fuer alle Betreiber dasselbe ist - einen
	// Schluessel kann sie gar nicht mitbekommen. Sie weist sich mit ihrer Sitzung
	// aus, der Server nimmt beides.
	it("schickt die Meldung ohne Schluessel, aber mit der Sitzung", async () => {
		vi.resetModules();
		vi.doMock("./defaults", () => ({ APP_VERSION: "9.9.9", TELEMETRY_KEY: "" }));
		const { sendDailyTelemetryPing: ohneSchluessel } = await import("./analytics");

		expect(await ohneSchluessel("https://tracker.example.de")).toBe("sent");
		const [, init] = fetchMock.mock.calls[0];
		expect(init.headers["x-telemetry-key"]).toBeUndefined();
		expect(init.credentials).toBe("include");

		vi.doUnmock("./defaults");
		vi.resetModules();
	});

	// Weder Schluessel noch Sitzung: der Server antwortet 401, und dabei bleibt es.
	it("gibt auf, wenn der Server auch die Sitzung nicht gelten laesst", async () => {
		vi.resetModules();
		vi.doMock("./defaults", () => ({ APP_VERSION: "9.9.9", TELEMETRY_KEY: "" }));
		const { sendDailyTelemetryPing: ohneSchluessel } = await import("./analytics");

		fetchMock.mockResolvedValue({ ok: false, status: 401 });
		expect(await ohneSchluessel("https://tracker.example.de")).toBe("declined");

		vi.doUnmock("./defaults");
		vi.resetModules();
	});
});
