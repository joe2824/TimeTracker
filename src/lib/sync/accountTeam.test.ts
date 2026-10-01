// Was das Konto tut, wenn die Team-Mitgliedschaft über den Abgleich hereinkommt.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FakeSyncServer } from "../testing/fakeSyncServer";
import { freshAccountEnv, restoreFetch, settled } from "../testing/accountHarness";
import type { TeamDeviceInfo } from "../store";
import type { VaultKey } from "../crypto/vault";

vi.mock("@tauri-apps/plugin-fs", async () => (await import("../testing/fakeFs")).fakeFs);
vi.mock("svelte-sonner", () => import("../testing/toastStub"));

const leaveTeamOnServer = vi.fn();
vi.mock("../team/api", () => ({
	leaveTeamOnServer: (...args: unknown[]) => leaveTeamOnServer(...args)
}));

const { createVaultKey, sealRecord } = await import("../crypto/vault");
const { account } = await import("./account.svelte");
const { TEAM_RECORD_ID } = await import("./outbox");
const store = await import("../store");

const TEAM: TeamDeviceInfo = { teamMemberId: "m1", token: "team-tok", teamName: "Vertrieb", serverUrl: "http://test" };

let server: FakeSyncServer;
let key: VaultKey;

/** Ein anderes Gerät desselben Kontos schreibt die Mitgliedschaft - oder löscht sie (`null`). */
async function fromAnotherDevice(team: TeamDeviceInfo | null): Promise<void> {
	const baseRev = server.rows.get(TEAM_RECORD_ID)?.rev ?? 0;
	const updatedAt = Date.now() + 1000;
	const record = team
		? {
				payload: await sealRecord(key, { ...team, id: TEAM_RECORD_ID }, { id: TEAM_RECORD_ID, kind: "team", rev: baseRev + 1 })
			}
		: { deletedAt: updatedAt };
	server.push("anderes-geraet", [{ id: TEAM_RECORD_ID, kind: "team", bucket: null, baseRev, updatedAt, ...record }]);
}

beforeEach(async () => {
	server = freshAccountEnv();
	leaveTeamOnServer.mockReset();
	leaveTeamOnServer.mockResolvedValue({ ok: true });
	key = await createVaultKey();
	await account.linkWithSession("http://test", key, "Ich");
	await settled();
});

afterEach(async () => {
	restoreFetch();
	await account.unlink();
});

describe("Team-Mitgliedschaft über das Konto", () => {
	it("meldet der Oberfläche, wenn sie hereinkommt", async () => {
		// Sonst zeigte ein laufendes Gerät bis zum Neustart das alte Team.
		const before = account.teamRevision;
		await fromAnotherDevice(TEAM);

		await account.syncNow();

		expect(await store.loadTeamDevice()).toEqual(TEAM);
		expect(account.teamRevision).toBeGreaterThan(before);
	});

	it("meldet der Oberfläche, wenn sie endet", async () => {
		await fromAnotherDevice(TEAM);
		await account.syncNow();
		const before = account.teamRevision;
		await fromAnotherDevice(null);

		await account.syncNow();

		expect(await store.loadTeamDevice()).toBeNull();
		expect(account.teamRevision).toBeGreaterThan(before);
	});

	it("meldet die Mitgliedschaft ab, die der Stand des Kontos ersetzt", async () => {
		// Vor dem Umbau trat jedes Gerät einzeln bei. Bliebe die ersetzte
		// Mitgliedschaft stehen, stünde sie beim Team für immer als "kein Bericht".
		const local = { ...TEAM, teamMemberId: "m-hier", token: "tok-hier" };
		await store.saveTeamDevice(local);
		await settled();
		await fromAnotherDevice(TEAM);

		await account.syncNow();

		expect(await store.loadTeamDevice()).toEqual(TEAM);
		expect(leaveTeamOnServer).toHaveBeenCalledWith(local.serverUrl, local.token);
	});

	it("meldet nichts ab, wenn dieselbe Mitgliedschaft nur neu geschrieben wurde", async () => {
		await store.saveTeamDevice(TEAM);
		await settled();
		await fromAnotherDevice({ ...TEAM, teamName: "Vertrieb Süd" });

		await account.syncNow();

		expect((await store.loadTeamDevice())?.teamName).toBe("Vertrieb Süd");
		expect(leaveTeamOnServer).not.toHaveBeenCalled();
	});
});
