// Ob der `app`-Zwischenspeicher nach einem gescheiterten Abgleich nicht hinter
// der Platte zurückbleibt. Sonst überschreibt der nächste lokale Save (z.B.
// Timer-Start) einen frisch angekommenen Eintrag mit dem alten Stand -
// diffAndStamp sieht ihn dann als "gelöscht" an und wirft ihn samt Löschung
// in die Outbox.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeSyncServer } from "../testing/fakeSyncServer";
import { freshAccountEnv, restoreFetch, settled } from "../testing/accountHarness";

vi.mock("@tauri-apps/plugin-fs", async () => (await import("../testing/fakeFs")).fakeFs);
vi.mock("svelte-sonner", () => import("../testing/toastStub"));

const { createVaultKey } = await import("../crypto/vault");
const { account } = await import("./account.svelte");
const { app } = await import("../app.svelte");
const store = await import("../store");
const { applyingRemote } = await import("./outbox");
const { monthKey } = await import("../time/time");
const { BUILTIN_OTHERS_ID } = await import("../types");

let server: FakeSyncServer;

beforeEach(() => {
	server = freshAccountEnv();
});

afterEach(restoreFetch);

describe("Zwischenspeicher nach gescheitertem Abgleich", () => {
	it("liest nach einem gescheiterten Durchgang neu, statt einen bereits eingetroffenen Eintrag zu verlieren", async () => {
		try {
			await account.linkWithSession("http://test", await createVaultKey(), "Ich");
			await settled();

			const month = monthKey(Date.now());
			// Eine zweite Aktivität, damit der lokale Start unten wirklich
			// wechselt - dieselbe wie beim entfernten Eintrag würde #startInternal
			// als "läuft schon" ohne jede Wirkung durchgehen lassen.
			await store.saveActivities([
				...(await store.loadActivities()),
				{ id: "eigene", name: "Eigene", sortOrder: 1, archived: false, isAbsence: false }
			]);
			// So sieht es aus, wenn eine Runde einen von woanders gestarteten Timer
			// schon auf die Platte geschrieben hat, bevor sie später scheitert:
			// `applyingRemote` unterdrückt den Schreib-Haken genau wie beim echten
			// Einspielen von Server-Daten.
			await applyingRemote(() =>
				store.saveEntries(month, [
					{
						id: "von-anderswo",
						activityId: BUILTIN_OTHERS_ID,
						startTs: Date.now() - 3600_000,
						endTs: null,
						note: "",
						source: "timer",
						updatedAt: Date.now() - 3600_000,
						rev: 1,
						deviceId: "anderes-geraet"
					}
				])
			);

			const realFetch = globalThis.fetch;
			globalThis.fetch = async () => {
				throw new Error("Netzwerk weg");
			};
			await account.syncNow();
			globalThis.fetch = realFetch;

			// Der Zwischenspeicher hat den Eintrag jetzt - der Durchgang ist
			// gescheitert, aber das Neuladen im catch-Zweig lief trotzdem.
			expect(app.monthEntries(month).some((e) => e.id === "von-anderswo")).toBe(true);

			// Und ein lokaler Timer-Start überschreibt ihn nicht mehr als
			// "gelöscht": #openEntries() findet und schließt ihn jetzt, statt ihn
			// unbemerkt aus der stehengebliebenen Kopie zu verlieren.
			await app.startActivity("eigene");
			const stored = await store.loadEntries(month);
			const remote = stored.find((e) => e.id === "von-anderswo");
			expect(remote).toBeDefined();
			expect(remote!.endTs).not.toBeNull();
		} finally {
			restoreFetch();
			await account.unlink();
		}
	});
});
