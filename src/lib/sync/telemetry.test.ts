import { beforeEach, describe, expect, it, vi } from "vitest";

// Der Schluessel wird beim Bauen eingesetzt; im Test steht er sonst leer.
vi.mock("../defaults", () => ({ APP_VERSION: "9.9.9", TELEMETRY_KEY: "schluessel-aus-dem-build" }));

import { Api, ApiError } from "./api";

const fetchMock = vi.fn();
const api = (token: string | null) =>
	new Api({ baseUrl: "https://tracker.example.de", token, fetchFn: fetchMock });

const ping = { deviceId: "geraet-1234", version: "9.9.9", platform: "macos" };

/** Die Antwort, die der Server auf eine angenommene Meldung gibt. */
const accepted = () =>
	new Response(JSON.stringify({ ok: true }), {
		status: 200,
		headers: { "content-type": "application/json" }
	});

beforeEach(() => {
	fetchMock.mockReset();
	fetchMock.mockResolvedValue(accepted());
});

describe("Api.telemetry", () => {
	it("schickt Kennung, Version und Plattform an den Telemetrie-Endpunkt", async () => {
		await api("geraetetoken").telemetry(ping);

		expect(fetchMock).toHaveBeenCalledTimes(1);
		const [url, init] = fetchMock.mock.calls[0];
		expect(url).toBe("https://tracker.example.de/api/telemetry");
		expect(init.method).toBe("POST");
		expect(JSON.parse(init.body)).toEqual(ping);
	});

	// Der Ausweis ist derselbe wie bei jedem anderen Serveraufruf. Ein eigener
	// Weg hier hiesse, dass die PWA - die keinen Schluessel aus dem Build hat -
	// gar nicht erst durchkaeme.
	it("weist sich mit dem Geraetetoken aus und legt den Build-Schluessel dazu", async () => {
		await api("geraetetoken").telemetry(ping);

		const [, init] = fetchMock.mock.calls[0];
		expect(init.headers.authorization).toBe("Bearer geraetetoken");
		expect(init.headers["x-telemetry-key"]).toBe("schluessel-aus-dem-build");
		expect(init.credentials).toBe("omit");
	});

	it("faellt ohne Token auf das Sitzungs-Cookie zurueck", async () => {
		await api(null).telemetry(ping);

		const [, init] = fetchMock.mock.calls[0];
		expect(init.headers.authorization).toBeUndefined();
		expect(init.credentials).toBe("include");
	});

	it("meldet den Status, damit der Aufrufer ihn einordnen kann", async () => {
		fetchMock.mockResolvedValue(new Response("nope", { status: 404 }));

		await expect(api("t").telemetry(ping)).rejects.toMatchObject({ status: 404 });
	});

	it("meldet einen Netzfehler als Status 0", async () => {
		fetchMock.mockRejectedValue(new Error("kein Netz"));

		const failure = await api("t")
			.telemetry(ping)
			.catch((e) => e);
		expect(failure).toBeInstanceOf(ApiError);
		expect(failure.status).toBe(0);
	});
});
