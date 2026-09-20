import { beforeEach, describe, expect, it, vi } from "vitest";

const previewTeam = vi.fn();
const completeTeamJoin = vi.fn();
vi.mock("./join", () => ({
	previewTeam: (...args: unknown[]) => previewTeam(...args),
	completeTeamJoin: (...args: unknown[]) => completeTeamJoin(...args)
}));

const { TeamJoinFlow } = await import("./joinFlow.svelte");

beforeEach(() => {
	previewTeam.mockReset();
	completeTeamJoin.mockReset();
});

describe("TeamJoinFlow", () => {
	it("laedt die Vorschau und faengt einen Fehlschlag als 'error' ab", async () => {
		const flow = new TeamJoinFlow();
		previewTeam.mockResolvedValue({ teamName: "Vertrieb" });

		await flow.loadPreview("https://tt.example.de", "code1");
		expect(flow.preview).toEqual({ teamName: "Vertrieb" });

		previewTeam.mockRejectedValue(new Error("abgelaufen"));
		await flow.loadPreview("https://tt.example.de", "code2");
		expect(flow.preview).toBe("error");
	});

	it("ignoriert die späte Antwort eines älteren Links", async () => {
		const flow = new TeamJoinFlow();
		let resolveFirst!: (v: { teamName: string }) => void;
		previewTeam
			.mockImplementationOnce(() => new Promise((resolve) => (resolveFirst = resolve)))
			.mockResolvedValueOnce({ teamName: "Einkauf" });

		const first = flow.loadPreview("https://tt.example.de", "codeA");
		await flow.loadPreview("https://tt.example.de", "codeB");
		resolveFirst({ teamName: "Vertrieb" });
		await first;

		expect(flow.preview).toEqual({ teamName: "Einkauf" });
	});

	it("ignoriert den Fehlschlag eines älteren Links", async () => {
		const flow = new TeamJoinFlow();
		let rejectFirst!: (e: Error) => void;
		previewTeam
			.mockImplementationOnce(() => new Promise((_, reject) => (rejectFirst = reject)))
			.mockResolvedValueOnce({ teamName: "Einkauf" });

		const first = flow.loadPreview("https://tt.example.de", "codeA");
		await flow.loadPreview("https://tt.example.de", "codeB");
		rejectFirst(new Error("abgelaufen"));
		await first;

		expect(flow.preview).toEqual({ teamName: "Einkauf" });
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
		completeTeamJoin.mockRejectedValue(new Error("Link nicht gültig"));

		const info = await flow.join("https://tt.example.de", "code1");

		expect(info).toBeNull();
		expect(flow.joinError).toBe("Link nicht gültig");
		expect(flow.busy).toBe(false);
	});

	it("ignoriert einen zweiten Beitritts-Versuch, waehrend der erste noch laeuft", async () => {
		const flow = new TeamJoinFlow();
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
