// Scharfer Test für strikte Kontoisolation bei Neuregistrierung und Kontowechsel.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Activity, Entry, Settings, SyncMeta } from "../types";
import { defaultSettings } from "../types";
import { files, resetFakeFs } from "../testing/fakeFs";
import type { ServerRecord } from "./api";

vi.mock("@tauri-apps/plugin-fs", async () => (await import("../testing/fakeFs")).fakeFs);
vi.mock("svelte-sonner", () => ({
	toast: Object.assign(() => {}, {
		info() {},
		error() {},
		success() {},
		warning() {},
		loading() {},
		dismiss() {}
	})
}));

const { createVaultKey, vaultProof } = await import("../crypto/vault");
const { account } = await import("./account.svelte");
const { app } = await import("../app.svelte");
const store = await import("../store");
const { resetOutboxForTests } = await import("./outbox");

class MockServer {
	userVaults = new Map<string, Map<string, ServerRecord>>();
	userSeqs = new Map<string, number>();
	userDisplayNames = new Map<string, string>();
	currentUser = "u1";

	private getRows(user = this.currentUser) {
		let map = this.userVaults.get(user);
		if (!map) {
			map = new Map();
			this.userVaults.set(user, map);
		}
		return map;
	}

	push(deviceId: string, records: unknown[], user = this.currentUser) {
		const rows = this.getRows(user);
		let seq = this.userSeqs.get(user) ?? 0;
		const accepted: { id: string; rev: number; seq: number }[] = [];
		const conflicts: { id: string; current: ServerRecord }[] = [];
		for (const raw of records as {
			id: string;
			kind: string;
			bucket?: string | null;
			baseRev: number;
			updatedAt: number;
			deletedAt?: number | null;
			payload?: string | null;
		}[]) {
			const vorhanden = rows.get(raw.id);
			const serverRev = vorhanden?.rev ?? 0;
			if (serverRev !== raw.baseRev) {
				conflicts.push({
					id: raw.id,
					current: vorhanden ?? {
						id: raw.id,
						kind: raw.kind,
						bucket: null,
						seq: 0,
						rev: 0,
						updatedAt: 0,
						deviceId: null,
						deletedAt: null,
						payload: null
					}
				});
				continue;
			}
			seq++;
			const rev = serverRev + 1;
			rows.set(raw.id, {
				id: raw.id,
				kind: raw.kind,
				bucket: raw.bucket ?? null,
				seq,
				rev,
				updatedAt: raw.updatedAt,
				deviceId,
				deletedAt: raw.deletedAt ?? null,
				payload: raw.deletedAt ? null : (raw.payload ?? null)
			});
			accepted.push({ id: raw.id, rev, seq });
		}
		this.userSeqs.set(user, seq);
		return { accepted, conflicts, seq };
	}

	pull(since: number, limit = 200, user = this.currentUser) {
		const rows = this.getRows(user);
		const alle = [...rows.values()].filter((r) => r.seq > since).sort((a, b) => a.seq - b.seq);
		const seite = alle.slice(0, limit);
		return {
			records: seite,
			nextSeq: seite.length > 0 ? seite[seite.length - 1].seq : since,
			hasMore: alle.length > limit
		};
	}

	fetchFor(deviceId: string) {
		return async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
			const rawUrl = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
			const url = new URL(rawUrl, "http://test-server");
			const parts = url.pathname.split("/").filter(Boolean);
			let user = this.currentUser;
			let pathname = url.pathname;
			if (parts.length >= 2 && parts[1] === "api") {
				user = parts[0];
				pathname = "/" + parts.slice(1).join("/");
			}

			if (pathname === "/api/sync" && (init?.method ?? "GET") === "GET") {
				const since = Number(url.searchParams.get("since") ?? 0);
				const res = this.pull(since, 200, user);
				return new Response(JSON.stringify(res), { status: 200 });
			}
			if (pathname === "/api/sync" && init?.method === "POST") {
				const body = JSON.parse(String(init.body));
				const res = this.push(deviceId, body.records, user);
				return new Response(JSON.stringify(res), {
					status: 200
				});
			}
			if (pathname === "/api/me" && init?.method === "PATCH") {
				const body = JSON.parse(String(init.body));
				if (body.displayName) this.userDisplayNames.set(user, body.displayName);
				return new Response(
					JSON.stringify({
						userId: user,
						displayName: this.userDisplayNames.get(user) ?? user,
						isAdmin: false
					}),
					{ status: 200 }
				);
			}
			if (pathname === "/api/me") {
				return new Response(
					JSON.stringify({
						userId: user,
						displayName: this.userDisplayNames.get(user) ?? user,
						isAdmin: false
					}),
					{
						status: 200
					}
				);
			}
			if (pathname === "/api/auth/logout") {
				return new Response(JSON.stringify({ ok: true }), { status: 200 });
			}
			return new Response(JSON.stringify({ message: "unbekannt" }), { status: 404 });
		};
	}
}

beforeEach(async () => {
	resetFakeFs();
	resetOutboxForTests();
	app.dispose();
	app.clearLocalData();
});

describe("Scharfe Kontoisolation (Web & Desktop)", () => {
	it("Neuregistrierung auf neuem Server übernimmt KEINE Einstellungen eines alten Nutzers", async () => {
		// 1. Altes Konto hinterlässt Daten im Speicher (z. B. vorherige Browser-Session)
		files.set(
			"data/settings.json",
			JSON.stringify({
				...defaultSettings,
				bossEmail: "geheim@altes-konto.de",
				senderName: "Alter Nutzer",
				rounding: 0.5,
				hoursPerDay: 6
			})
		);
		files.set(
			"data/activities.json",
			JSON.stringify([{ id: "akt-alt", name: "Altes Projekt", color: "#ff0000", sortOrder: 0 }])
		);
		files.set(
			"data/entries-2026-08.json",
			JSON.stringify([{ id: "e-alt", activityId: "akt-alt", startTs: 1000, endTs: 2000, note: "Alt", source: "timer" }])
		);

		// 2. Neuer Server mit komplett frischer Datenbank
		const neuerServer = new MockServer();
		const originalFetch = globalThis.fetch;
		globalThis.fetch = neuerServer.fetchFor("browser-device");

		try {
			// 3. Neuer User registriert sich und verknüpft Session im Browser
			const keyNeu = await createVaultKey();
			await account.linkWithSession("http://test-server", keyNeu, "Neuer Nutzer");

			// 4. Prüfungen:
			// a) Der Server-Tresor von User 2 darf KEINE Zeilen mit den alten Einstellungen oder Einträgen von User 1 enthalten!
			expect(neuerServer.userVaults.size).toBe(0);

			// b) Im lokalen State von User 2 müssen saubere defaultSettings stehen
			expect(app.settings.bossEmail).toBe("");
			expect(app.settings.senderName).toBe("");
			expect(app.settings.rounding).toBe(defaultSettings.rounding);
			expect(app.settings.hoursPerDay).toBe(defaultSettings.hoursPerDay);

			// c) Aktivitäten und Einträge müssen für den neuen User leer sein
			expect(app.activities).toEqual([]);
			expect(await store.loadEntries("2026-08")).toEqual([]);

			// d) Auf der Platte darf keine alte settings.json herumliegen
			const gespeicherteSettings = await store.loadSettings();
			expect(gespeicherteSettings.bossEmail).toBe("");
			expect(gespeicherteSettings.senderName).toBe("");
		} finally {
			globalThis.fetch = originalFetch;
			await account.unlink();
		}
	});

	it("account.init() im Browser ohne aktive Sitzung bereinigt alte Speicher-Rückstände", async () => {
		// Speicher enthält Rückstände einer alten Sitzung
		files.set("data/settings.json", JSON.stringify({ ...defaultSettings, bossEmail: "leiche@firma.de" }));
		files.set("data/activities.json", JSON.stringify([{ id: "a1", name: "Leiche" }]));
		files.set("data/entries-2026-08.json", JSON.stringify([{ id: "e1", activityId: "a1", startTs: 100 }]));
		files.set("data/timereport-2026-08.json", JSON.stringify({ month: "2026-08", days: [] }));
		files.set("data/outbox.json", JSON.stringify([{ kind: "entry", id: "e1" }]));

		// account.init() läuft beim Seitenaufruf
		await account.init();

		// Alles muss rückstandslos bereinigt sein
		expect(files.has("data/settings.json")).toBe(false);
		expect(files.has("data/activities.json")).toBe(false);
		expect(files.has("data/entries-2026-08.json")).toBe(false);
		expect(files.has("data/timereport-2026-08.json")).toBe(false);
		expect(files.has("data/outbox.json")).toBe(false);

		expect(app.settings.bossEmail).toBe("");
		expect(app.activities).toEqual([]);
	});

	it("Kontowechsel: User A und User B bleiben auf demselben Server strikt voneinander isoliert", async () => {
		const server = new MockServer();
		const originalFetch = globalThis.fetch;
		globalThis.fetch = server.fetchFor("browser-device");

		try {
			// User A anlegen & konfigurieren
			const keyA = await createVaultKey();
			await account.linkWithSession("http://test-server/alice", keyA, "Alice");
			await app.updateSettings({
				senderName: "Alice Wunder",
				bossEmail: "chef@alice.de",
				hoursPerDay: 7
			});
			await account.syncNow();

			expect(app.settings.senderName).toBe("Alice Wunder");
			expect(app.settings.bossEmail).toBe("chef@alice.de");

			// User A meldet sich ab
			await account.logout();

			// Nach dem Logout ist der Browser komplett leer
			expect(app.settings.senderName).toBe("");
			expect(app.settings.bossEmail).toBe("");
			expect(files.has("data/settings.json")).toBe(false);

			// User B loggt sich ein / registriert sich mit eigenem Schlüssel
			const keyB = await createVaultKey();
			await account.linkWithSession("http://test-server/bob", keyB, "Bob");
			await account.syncNow();

			// User B hat saubere defaultSettings und sieht NICHTS von Alice!
			expect(app.settings.senderName).toBe("");
			expect(app.settings.bossEmail).toBe("");
			expect(app.settings.hoursPerDay).toBe(defaultSettings.hoursPerDay);

			// User B setzt seine eigenen Einstellungen
			await app.updateSettings({
				senderName: "Bob Baumeister",
				bossEmail: "leitung@bob.de",
				hoursPerDay: 9
			});
			await account.syncNow();

			expect(app.settings.senderName).toBe("Bob Baumeister");
			expect(app.settings.bossEmail).toBe("leitung@bob.de");

			// User B meldet sich ab
			await account.logout();

			// Alice meldet sich wieder mit ihrem Schlüssel an
			await account.linkWithSession("http://test-server/alice", keyA, "Alice");
			await account.syncNow();

			// Alice bekommt wieder ihre exakten Einstellungen zurück
			expect(app.settings.senderName).toBe("Alice Wunder");
			expect(app.settings.bossEmail).toBe("chef@alice.de");
			expect(app.settings.hoursPerDay).toBe(7);
		} finally {
			globalThis.fetch = originalFetch;
			await account.unlink();
		}
	});

	it("Bug-Reproduktionstest: Neuregistrierung nach alter Session darf NIEMALS Altdaten in Einstellungen oder Server laden", async () => {
		// Simulation: Der Browser hat noch Überreste von einem früheren Account X
		files.set(
			"data/settings.json",
			JSON.stringify({
				...defaultSettings,
				bossEmail: "alt@firma-xyz.de",
				senderName: "Alter Account",
				teamSubjectFilter: "StrengGeheim",
				hoursPerDay: 4
			})
		);
		files.set(
			"data/activities.json",
			JSON.stringify([{ id: "akt-alt", name: "Altes Projekt", color: "#123456", sortOrder: 0 }])
		);
		files.set(
			"data/entries-2026-08.json",
			JSON.stringify([{ id: "e-alt", activityId: "akt-alt", startTs: 100, endTs: 200, note: "Geheim", source: "timer" }])
		);

		// Neuer Server, neue DB
		const frischerServer = new MockServer();
		frischerServer.currentUser = "user-neu";
		const originalFetch = globalThis.fetch;
		globalThis.fetch = frischerServer.fetchFor("device-neu");

		try {
			// Vor dem Linken: account.init() läuft beim Aufruf der Seite
			await account.init();

			// Nach init() muss bereits alles abgeräumt sein
			expect(files.has("data/settings.json")).toBe(false);
			expect(app.settings.bossEmail).toBe("");
			expect(app.settings.senderName).toBe("");

			// Neuer User registriert sich und verknüpft Session
			const keyNeu = await createVaultKey();
			await account.linkWithSession("http://frischer-server", keyNeu, "");
			await account.syncNow();

			// 1. Lokale Einstellungen müssen 100% jungfräulich sein
			expect(app.settings.bossEmail).toBe("");
			expect(app.settings.senderName).toBe("");
			expect(app.settings.teamSubjectFilter).toBe(defaultSettings.teamSubjectFilter);
			expect(app.settings.hoursPerDay).toBe(defaultSettings.hoursPerDay);
			expect(app.activities).toEqual([]);

			// 2. Im Tresor auf dem Server darf KEIN Datensatz von den Altdaten liegen
			const vaultNeu = frischerServer.userVaults.get("user-neu");
			expect(vaultNeu?.size ?? 0).toBe(0);
		} finally {
			globalThis.fetch = originalFetch;
			await account.unlink();
		}
	});

	it("Nach Neuregistrierung im Browser und Überspringen der Desktop-Kopplung öffnet sich das Onboarding", async () => {
		const server = new MockServer();
		server.currentUser = "frischer-user";
		const originalFetch = globalThis.fetch;
		globalThis.fetch = server.fetchFor("device-web");

		try {
			// 1. Neuer User registriert sich im Browser
			const keyNeu = await createVaultKey();
			await account.linkWithSession("http://test-server/frischer-user", keyNeu, "Mein Account");

			// 2. Er entscheidet sich gegen Desktop-Kopplung
			app.openOnboarding();
			expect(app.showOnboarding).toBe(true);

			// 3. User durchläuft das Onboarding und speichert seine Werte
			await app.finishOnboarding({
				senderName: "Max Mustermann",
				bossEmail: "chef@firma.de",
				hoursPerDay: 8
			});

			expect(app.showOnboarding).toBe(false);
			expect(app.settings.senderName).toBe("Max Mustermann");
			expect(app.settings.bossEmail).toBe("chef@firma.de");

			// 4. Daten werden in den neuen Tresor synchronisiert
			await new Promise((r) => setTimeout(r, 50));
			await account.syncNow();
			const vault = server.userVaults.get("frischer-user");
			expect(vault?.size).toBeGreaterThan(0);
		} finally {
			globalThis.fetch = originalFetch;
			await account.unlink();
		}
	});
});
