// Der Weg ins Netz - und warum es zwei davon gibt.
import { afterEach, describe, expect, it, vi } from "vitest";
import { platformFetch } from "./http";

afterEach(() => {
	vi.unstubAllGlobals();
	vi.resetModules();
	vi.doUnmock("@tauri-apps/plugin-http");
});

describe("Abrufmethode der Umgebung", () => {
	it("nimmt im Browser das eingebaute fetch", async () => {
		const eingebaut = vi.fn(async () => new Response("{}", { status: 200 }));
		vi.stubGlobal("fetch", eingebaut);

		const res = await platformFetch("https://example.test/api/health");

		expect(eingebaut).toHaveBeenCalledOnce();
		expect(res.status).toBe(200);
	});

	it("reicht Methode und Kopfzeilen unveraendert weiter", async () => {
		const eingebaut = vi.fn(async () => new Response("{}", { status: 200 }));
		vi.stubGlobal("fetch", eingebaut);

		await platformFetch("https://example.test/api/sync", {
			method: "POST",
			headers: { authorization: "Bearer geheim" }
		});

		const [adresse, init] = eingebaut.mock.calls[0] as unknown as [string, RequestInit];
		expect(adresse).toBe("https://example.test/api/sync");
		expect(init.method).toBe("POST");
		expect((init.headers as Record<string, string>).authorization).toBe("Bearer geheim");
	});

	it("geht in der Desktop-Huelle NICHT ueber das eingebaute fetch", async () => {
		// Das ist der Kern: sobald Tauri sich zu erkennen gibt, darf das eingebaute
		// fetch nicht mehr angefasst werden - sonst ist man wieder im Browserkern
		// mit seiner Herkunftspruefung.
		const eingebaut = vi.fn(async () => new Response("{}", { status: 200 }));
		vi.stubGlobal("fetch", eingebaut);
		// So gibt Tauri sich zu erkennen - siehe isTauri() in env.ts.
		vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });
		vi.doMock("@tauri-apps/plugin-http", () => ({
			fetch: vi.fn(async () => new Response("{}", { status: 299 }))
		}));

		// Frisch laden, damit die Attrappe greift und kein gemerkter Wert stoert.
		vi.resetModules();
		const { platformFetch: frisch } = await import("./http");
		const res = await frisch("https://example.test/api/health");

		expect(eingebaut).not.toHaveBeenCalled();
		expect(res.status).toBe(299);
	});
});
