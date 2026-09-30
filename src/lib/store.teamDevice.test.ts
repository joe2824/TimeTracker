// team.json: das Team-Token liegt wie das Geräte-Token geschützt ab.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { files, resetFakeFs } from "./testing/fakeFs";

vi.mock("@tauri-apps/plugin-fs", async () => (await import("./testing/fakeFs")).fakeFs);

/** Wie auf dem Rechner: das Betriebssystem schützt (hier: ein erkennbarer Umschlag). */
const secrets = vi.hoisted(() => ({ osProtects: true }));
vi.mock("./platform/secrets", () => ({
	protectSecret: async (plain: string) =>
		secrets.osProtects ? { data: `os:${plain}`, protected: true } : { data: btoa(plain), protected: false },
	unprotectSecret: async (data: string, wasProtected: boolean) => {
		if (!wasProtected) return atob(data);
		if (!data.startsWith("os:")) throw new Error("an ein anderes Gerät gebunden");
		return data.slice(3);
	}
}));

const { loadTeamDevice, saveTeamDevice } = await import("./store");

const INFO = { teamMemberId: "m1", token: "geheimes-token", teamName: "Vertrieb", serverUrl: "https://firma.de" };
const stored = () => JSON.parse(files.get("data/team.json") ?? "null");

beforeEach(() => {
	resetFakeFs();
	secrets.osProtects = true;
});

describe("team.json", () => {
	it("legt das Token geschützt ab und liest es zurück", async () => {
		await saveTeamDevice(INFO);
		expect(stored()).toMatchObject({ token: "os:geheimes-token", protected: true, teamName: "Vertrieb" });
		expect(files.get("data/team.json")).not.toContain('"geheimes-token"');
		expect(await loadTeamDevice()).toEqual(INFO);
	});

	it("im Browser bleibt es ungeschützt, aber lesbar", async () => {
		secrets.osProtects = false;
		await saveTeamDevice(INFO);
		expect(stored().protected).toBe(false);
		expect(await loadTeamDevice()).toEqual(INFO);
	});

	it("liest eine alte Klartext-Datei und schreibt sie geschützt neu", async () => {
		files.set("data/team.json", JSON.stringify(INFO));

		expect(await loadTeamDevice()).toEqual(INFO);
		await vi.waitFor(() => expect(stored().protected).toBe(true));
		expect(stored().token).toBe("os:geheimes-token");
		expect(await loadTeamDevice()).toEqual(INFO);
	});

	it("ein Token, das sich hier nicht öffnen lässt, gilt als keine Mitgliedschaft", async () => {
		files.set("data/team.json", JSON.stringify({ ...INFO, token: "fremd", protected: true }));
		expect(await loadTeamDevice()).toBeNull();
	});
});
