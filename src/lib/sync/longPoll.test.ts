// Ob die Weckruf-Schleife eine bereits beantwortete Anfrage später noch
// abbricht. tauri-plugin-http meldet ein `fetch_cancel` auf eine abgeräumte
// Anfrage als unbehandelte Promise-Ablehnung ("The resource id ... is
// invalid") - sichtbar im Protokoll, ohne dass etwas kaputt wäre.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { freshAccountEnv, restoreFetch, waitFor } from "../testing/accountHarness";

vi.mock("@tauri-apps/plugin-fs", async () => (await import("../testing/fakeFs")).fakeFs);
vi.mock("svelte-sonner", () => import("../testing/toastStub"));
vi.mock("@tauri-apps/plugin-http", () => ({
	fetch: (input: string | URL | Request, init?: RequestInit) => globalThis.fetch(input, init)
}));
// Die Schleife läuft nur in der Desktop-Hülle - ohne deren IPC nachzubauen.
vi.mock("../platform/env", () => ({
	isTauri: () => true,
	capabilities: {
		outlook: true,
		globalShortcuts: true,
		idleDetection: true,
		updater: true,
		tray: true,
		autostart: true,
		protectedSecrets: false
	}
}));
vi.mock("../platform/secrets", () => ({
	protectSecret: async (plain: string) => ({ data: btoa(plain), protected: false }),
	unprotectSecret: async (data: string) => atob(data)
}));

const { createVaultKey } = await import("../crypto/vault");
const { account } = await import("./account.svelte");

/** Die Signale, die an `/api/sync/wait` gingen - in der Reihenfolge der Anfragen. */
let waitSignals: (AbortSignal | undefined)[];

beforeEach(() => {
	const server = freshAccountEnv();
	const serverFetch = server.fetchFor("dieses-geraet");
	waitSignals = [];
	// `#openStream` steigt ohne EventSource aus, noch vor dem Zweig zur Schleife.
	globalThis.EventSource ??= class {} as unknown as typeof EventSource;
	globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
		const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		if (new URL(href, "http://test").pathname === "/api/sync/wait") {
			waitSignals.push(init?.signal ?? undefined);
			// Wie beim echten Server: die Anfrage bleibt kurz offen. Ohne das dreht
			// die Schleife im Leerlauf, bis der Worker aufgibt.
			await new Promise((r) => setTimeout(r, 20));
			return new Response(JSON.stringify({ seq: 0, changed: false }), {
				headers: { "content-type": "application/json" }
			});
		}
		return serverFetch(input, init);
	};
});

afterEach(() => {
	account.dispose();
	restoreFetch();
});

describe("Weckruf-Schleife", () => {
	it("bricht beantwortete Anfragen nicht nachträglich ab", async () => {
		await account.linkWithSession("http://test", await createVaultKey(), "Ich");
		await waitFor(() => waitSignals.length >= 2);

		// Die letzte Anfrage läuft noch - die darf der Abbruch treffen.
		const finished = waitSignals.slice(0, -1);
		account.dispose();

		expect(finished.length).toBeGreaterThan(0);
		expect(finished.every((s) => s && !s.aborted)).toBe(true);
	});
});
