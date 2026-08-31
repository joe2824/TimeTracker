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
		const builtin = vi.fn(async () => new Response("{}", { status: 200 }));
		vi.stubGlobal("fetch", builtin);

		const res = await platformFetch("https://example.test/api/health");

		expect(builtin).toHaveBeenCalledOnce();
		expect(res.status).toBe(200);
	});

	it("reicht Methode und Kopfzeilen unveraendert weiter", async () => {
		const builtin = vi.fn(async () => new Response("{}", { status: 200 }));
		vi.stubGlobal("fetch", builtin);

		await platformFetch("https://example.test/api/sync", {
			method: "POST",
			headers: { authorization: "Bearer geheim" }
		});

		const [address, init] = builtin.mock.calls[0] as unknown as [string, RequestInit];
		expect(address).toBe("https://example.test/api/sync");
		expect(init.method).toBe("POST");
		expect((init.headers as Record<string, string>).authorization).toBe("Bearer geheim");
	});

	it("geht in der Desktop-Huelle NICHT ueber das eingebaute fetch", async () => {
		// Das ist der Kern: sobald Tauri sich zu erkennen gibt, darf das eingebaute
		// fetch nicht mehr angefasst werden - sonst ist man wieder im Browserkern
		// mit seiner Herkunftspruefung.
		const builtin = vi.fn(async () => new Response("{}", { status: 200 }));
		vi.stubGlobal("fetch", builtin);
		// So gibt Tauri sich zu erkennen - siehe isTauri() in env.ts.
		vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });
		vi.doMock("@tauri-apps/plugin-http", () => ({
			fetch: vi.fn(async () => new Response("{}", { status: 299 }))
		}));

		// Frisch laden, damit die Attrappe greift und kein gemerkter Wert stoert.
		vi.resetModules();
		const { platformFetch: fresh } = await import("./http");
		const res = await fresh("https://example.test/api/health");

		expect(builtin).not.toHaveBeenCalled();
		expect(res.status).toBe(299);
	});
});
