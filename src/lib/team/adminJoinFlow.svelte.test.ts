import { beforeEach, describe, expect, it, vi } from "vitest";

const appInit = vi.fn();
const appDispose = vi.fn();
const accountInit = vi.fn();
const accountDispose = vi.fn();
const joinTeamAsAdmin = vi.fn();
const previewAdminInvite = vi.fn();

vi.mock("../app.svelte", () => ({
	app: { init: () => appInit(), dispose: () => appDispose() }
}));
vi.mock("../sync/account.svelte", () => ({
	account: {
		init: () => accountInit(),
		dispose: () => accountDispose(),
		joinTeamAsAdmin: (...args: unknown[]) => joinTeamAsAdmin(...args)
	}
}));
vi.mock("./api", () => ({
	previewAdminInvite: (...args: unknown[]) => previewAdminInvite(...args)
}));

const { AdminJoinFlow } = await import("./adminJoinFlow.svelte");

beforeEach(() => {
	for (const fn of [appInit, appDispose, accountInit, accountDispose, joinTeamAsAdmin, previewAdminInvite]) {
		fn.mockReset();
	}
});

describe("AdminJoinFlow.start", () => {
	it("startet App und Konto und meldet danach 'bereit'", async () => {
		appInit.mockResolvedValue(true);
		accountInit.mockResolvedValue(undefined);
		const flow = new AdminJoinFlow();

		await flow.start();

		expect(accountInit).toHaveBeenCalledOnce();
		expect(flow.ready).toBe(true);
		expect(flow.startFailed).toBe(false);
	});

	it("meldet einen Startfehler, statt ein nicht angemeldetes Konto vorzutäuschen", async () => {
		appInit.mockResolvedValue(false);
		const flow = new AdminJoinFlow();

		await flow.start();

		expect(accountInit).not.toHaveBeenCalled();
		expect(flow.ready).toBe(true);
		expect(flow.startFailed).toBe(true);
	});

	it("meldet einen Startfehler auch, wenn das Konto beim Start wirft", async () => {
		appInit.mockResolvedValue(true);
		accountInit.mockRejectedValue(new Error("Netzwerk weg"));
		const flow = new AdminJoinFlow();

		await flow.start();

		expect(flow.ready).toBe(true);
		expect(flow.startFailed).toBe(true);
	});
});

describe("AdminJoinFlow.loadPreview", () => {
	it("lädt die Vorschau und fängt einen Fehlschlag als 'error' ab", async () => {
		const flow = new AdminJoinFlow();
		previewAdminInvite.mockResolvedValueOnce({ teamName: "Vertrieb" });
		await flow.loadPreview("https://tt.example.de", "code1");
		expect(flow.preview).toEqual({ teamName: "Vertrieb" });

		previewAdminInvite.mockRejectedValueOnce(new Error("abgelaufen"));
		await flow.loadPreview("https://tt.example.de", "code2");
		expect(flow.preview).toBe("error");
	});

	it("ignoriert die späte Antwort eines älteren Links", async () => {
		const flow = new AdminJoinFlow();
		let resolveFirst!: (v: { teamName: string }) => void;
		previewAdminInvite
			.mockImplementationOnce(() => new Promise((resolve) => (resolveFirst = resolve)))
			.mockResolvedValueOnce({ teamName: "Einkauf" });

		const first = flow.loadPreview("https://tt.example.de", "codeA");
		await flow.loadPreview("https://tt.example.de", "codeB");
		resolveFirst({ teamName: "Vertrieb" });
		await first;

		expect(flow.preview).toEqual({ teamName: "Einkauf" });
	});

	it("ignoriert den Fehlschlag eines älteren Links", async () => {
		const flow = new AdminJoinFlow();
		let rejectFirst!: (e: Error) => void;
		previewAdminInvite
			.mockImplementationOnce(() => new Promise((_, reject) => (rejectFirst = reject)))
			.mockResolvedValueOnce({ teamName: "Einkauf" });

		const first = flow.loadPreview("https://tt.example.de", "codeA");
		await flow.loadPreview("https://tt.example.de", "codeB");
		rejectFirst(new Error("abgelaufen"));
		await first;

		expect(flow.preview).toEqual({ teamName: "Einkauf" });
	});
});

describe("AdminJoinFlow.accept", () => {
	it("merkt sich den Teamnamen nach dem Annehmen", async () => {
		joinTeamAsAdmin.mockResolvedValue({ id: "t1", name: "Vertrieb" });
		const flow = new AdminJoinFlow();

		await flow.accept("code1");

		expect(joinTeamAsAdmin).toHaveBeenCalledWith("code1");
		expect(flow.joinedTeamName).toBe("Vertrieb");
		expect(flow.busy).toBe(false);
		expect(flow.joinError).toBeNull();
	});

	it("hält den Fehlertext fest, wenn das Annehmen scheitert", async () => {
		joinTeamAsAdmin.mockRejectedValue(new Error("Link unbekannt oder abgelaufen"));
		const flow = new AdminJoinFlow();

		await flow.accept("code1");

		expect(flow.joinedTeamName).toBeNull();
		expect(flow.joinError).toContain("Link unbekannt");
		expect(flow.busy).toBe(false);
	});
});

describe("AdminJoinFlow.dispose", () => {
	it("stoppt Konto-Abgleich und App-Uhr", () => {
		new AdminJoinFlow().dispose();
		expect(accountDispose).toHaveBeenCalledOnce();
		expect(appDispose).toHaveBeenCalledOnce();
	});
});
