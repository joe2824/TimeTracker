import { beforeEach, describe, expect, it, vi } from "vitest";

const previewTeam = vi.fn();
const completeTeamJoin = vi.fn();
vi.mock("./join", () => ({
	completeTeamJoin: (...args: unknown[]) => completeTeamJoin(...args)
}));
vi.mock("./api", () => ({
	previewTeamInvite: (...args: unknown[]) => previewTeam(...args)
}));
const loadTeamDevice = vi.fn();
vi.mock("../store", () => ({
	loadTeamDevice: () => loadTeamDevice()
}));
const accountMock = vi.hoisted(() => ({ linked: false, serverUrl: "" }));
vi.mock("../sync/account.svelte", () => ({ account: accountMock }));

const { TeamJoinFlow } = await import("./joinFlow.svelte");

beforeEach(() => {
	previewTeam.mockReset();
	completeTeamJoin.mockReset();
	loadTeamDevice.mockReset();
	loadTeamDevice.mockResolvedValue(null);
	accountMock.linked = false;
	accountMock.serverUrl = "";
});

describe("TeamJoinFlow", () => {
	// Das Rennen zweier Links prüft linkPreview.svelte.test.ts.
	it("laedt die Vorschau und faengt einen Fehlschlag als 'error' ab", async () => {
		const flow = new TeamJoinFlow();
		previewTeam.mockResolvedValue({ teamName: "Vertrieb" });

		await flow.loadPreview("https://tt.example.de", "code1");
		expect(flow.preview).toEqual({ teamName: "Vertrieb" });

		previewTeam.mockRejectedValue(new Error("abgelaufen"));
		await flow.loadPreview("https://tt.example.de", "code2");
		expect(flow.preview).toBe("error");
	});

	it("tritt bei und liefert die Team-Infos", async () => {
		const flow = new TeamJoinFlow();
		flow.name = " Anna Meier ";
		flow.email = " anna@firma.de ";
		completeTeamJoin.mockResolvedValue({
			teamMemberId: "m1",
			token: "tok",
			teamName: "Vertrieb",
			serverUrl: "https://tt.example.de"
		});

		const info = await flow.join("https://tt.example.de", "code1");

		expect(completeTeamJoin).toHaveBeenCalledWith("https://tt.example.de", "code1", "Anna Meier", "anna@firma.de");
		expect(info?.teamName).toBe("Vertrieb");
		expect(flow.busy).toBe(false);
		expect(flow.joinError).toBeNull();
	});

	it("haelt den Fehlertext fest und liefert null bei einem Fehlschlag", async () => {
		const flow = new TeamJoinFlow();
		flow.name = "Anna Meier";
		completeTeamJoin.mockRejectedValue(new Error("Link nicht gültig"));

		const info = await flow.join("https://tt.example.de", "code1");

		expect(info).toBeNull();
		expect(flow.joinError).toBe("Link nicht gültig");
		expect(flow.busy).toBe(false);
	});

	it("ignoriert einen zweiten Beitritts-Versuch, waehrend der erste noch laeuft", async () => {
		const flow = new TeamJoinFlow();
		flow.name = "Anna Meier";
		let resolveJoin: (v: unknown) => void = () => {};
		completeTeamJoin.mockReturnValue(new Promise((resolve) => (resolveJoin = resolve)));

		const first = flow.join("https://tt.example.de", "code1");
		expect(flow.busy).toBe(true);
		const second = await flow.join("https://tt.example.de", "code1");

		expect(second).toBeNull();
		expect(completeTeamJoin).toHaveBeenCalledTimes(1);

		resolveJoin({ teamMemberId: "m1", token: "tok", teamName: "Vertrieb", serverUrl: "https://tt.example.de" });
		await first;
	});

	it("tritt nicht bei, solange eine eingetragene E-Mail ungültig ist", async () => {
		const flow = new TeamJoinFlow();
		flow.name = "Anna Meier";
		flow.email = "anna@firma.de; chef@firma.de";

		expect(flow.emailInvalid).toBe(true);
		expect(await flow.join("https://tt.example.de", "code1")).toBeNull();
		expect(completeTeamJoin).not.toHaveBeenCalled();

		flow.email = "";
		expect(flow.canJoinAt("https://tt.example.de")).toBe(true);
	});

	it("erkennt den Link des Teams, in dem das Gerät schon ist, und tritt nicht erneut bei", async () => {
		const flow = new TeamJoinFlow();
		flow.name = "Anna Meier";
		previewTeam.mockResolvedValue({ teamName: "Vertrieb" });
		await flow.loadPreview("https://tt.example.de", "code1");
		flow.existing = { teamMemberId: "m1", token: "tok", teamName: "Vertrieb", serverUrl: "https://tt.example.de/" };

		expect(flow.sameTeam("https://tt.example.de")).toBe(true);
		// Sonst löst Enter im Formular einen Beitritt aus, der ohne Fehlertext scheitert.
		expect(flow.canJoinAt("https://tt.example.de")).toBe(false);
		expect(await flow.join("https://tt.example.de", "code1")).toBeNull();
		expect(flow.joinError).toBeNull();
		expect(completeTeamJoin).not.toHaveBeenCalled();

		flow.existing = { ...flow.existing, teamName: "Einkauf" };
		expect(flow.sameTeam("https://tt.example.de")).toBe(false);
		expect(flow.canJoinAt("https://tt.example.de")).toBe(true);
	});

	it("setzt Eingaben und Fehlertext bei reset() zurueck", () => {
		const flow = new TeamJoinFlow();
		flow.name = "Anna";
		flow.email = "anna@firma.de";
		flow.joinError = "irgendwas";

		flow.reset();

		expect(flow.name).toBe("");
		expect(flow.email).toBe("");
		expect(flow.joinError).toBeNull();
	});
});

describe("TeamJoinFlow.openLink - Vorschau erst nach Rückfrage bei fremdem Server", () => {
	it("fragt bei einem unbekannten Server erst nach und lädt nichts", async () => {
		const flow = new TeamJoinFlow();
		await flow.openLink("https://fremd.example.org", "code1");

		expect(flow.consentHost).toBe("fremd.example.org");
		expect(previewTeam).not.toHaveBeenCalled();

		previewTeam.mockResolvedValue({ teamName: "Vertrieb" });
		await flow.confirmOpen();
		expect(flow.consentHost).toBeNull();
		expect(previewTeam).toHaveBeenCalledWith("https://fremd.example.org", "code1");
		expect(flow.preview).toEqual({ teamName: "Vertrieb" });
	});

	it("lädt sofort, wenn der Link zum Server des eigenen Kontos gehört", async () => {
		accountMock.linked = true;
		accountMock.serverUrl = "https://tt.example.de";
		previewTeam.mockResolvedValue({ teamName: "Vertrieb" });
		const flow = new TeamJoinFlow();

		await flow.openLink("https://TT.example.de/", "code1");

		expect(flow.consentHost).toBeNull();
		expect(previewTeam).toHaveBeenCalledWith("https://TT.example.de/", "code1");
	});

	it("ein nur hinterlegter, aber nicht verbundener Kontoserver zählt nicht", async () => {
		accountMock.linked = false;
		accountMock.serverUrl = "https://tt.example.de";
		const flow = new TeamJoinFlow();
		await flow.openLink("https://tt.example.de", "code1");
		expect(flow.consentHost).toBe("tt.example.de");
		expect(previewTeam).not.toHaveBeenCalled();
	});

	it("lädt sofort, wenn der Link zum Server des Teams gehört, in dem das Gerät schon ist", async () => {
		loadTeamDevice.mockResolvedValue({
			teamMemberId: "m1",
			token: "tok",
			teamName: "Einkauf",
			serverUrl: "https://team.example.de"
		});
		previewTeam.mockResolvedValue({ teamName: "Vertrieb" });
		const flow = new TeamJoinFlow();

		await flow.openLink("team.example.de", "code1");

		expect(flow.consentHost).toBeNull();
		expect(previewTeam).toHaveBeenCalledTimes(1);
	});

	it("ein neuerer Link verdrängt die offene Rückfrage", async () => {
		const flow = new TeamJoinFlow();
		await flow.openLink("https://fremd.example.org", "code1");
		accountMock.linked = true;
		accountMock.serverUrl = "https://tt.example.de";
		previewTeam.mockResolvedValue({ teamName: "Vertrieb" });

		await flow.openLink("https://tt.example.de", "code2");

		expect(flow.consentHost).toBeNull();
		expect(previewTeam).toHaveBeenCalledWith("https://tt.example.de", "code2");
		// Ein später Klick auf die alte Rückfrage lädt nichts mehr.
		await flow.confirmOpen();
		expect(previewTeam).toHaveBeenCalledTimes(1);
	});
});
