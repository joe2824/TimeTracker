import { beforeEach, describe, expect, it, vi } from "vitest";

const appMock = vi.hoisted(() => ({
	now: Date.now(),
	backdatePrompt: null as unknown,
	startActivity: vi.fn()
}));
vi.mock("../app.svelte", () => ({ app: appMock }));
vi.mock("svelte-sonner", () => import("../testing/toastStub"));

const { StartPicker } = await import("./startPicker.svelte");

beforeEach(() => {
	appMock.now = Date.now();
	appMock.backdatePrompt = null;
	appMock.startActivity.mockReset().mockResolvedValue(undefined);
});

describe("StartPicker", () => {
	it("startet bei 'jetzt' ohne Rückdatierung", async () => {
		const picker = new StartPicker();
		expect(picker.hint).toBeNull();
		await expect(picker.start("p1")).resolves.toBe(true);
		expect(appMock.startActivity).toHaveBeenCalledWith("p1", undefined);
	});

	it("datiert um das Preset zurück und setzt danach auf 'jetzt' zurück", async () => {
		const picker = new StartPicker();
		picker.choosePreset(15);
		expect(picker.hint).toMatch(/^Timer beginnt um \d\d:\d\d$|über Mitternacht/);

		await picker.start("p1");

		const startTs = appMock.startActivity.mock.calls[0][1] as number;
		expect(Date.now() - startTs).toBeGreaterThanOrEqual(15 * 60_000);
		expect(picker.presetMin).toBe(0);
		expect(picker.customStart).toBe("");
	});

	it("behält die Auswahl, solange die Rückfrage zum Rückdatieren offen ist", async () => {
		const picker = new StartPicker();
		picker.choosePreset(30);
		appMock.startActivity.mockImplementation(async () => {
			appMock.backdatePrompt = { activityId: "p1" };
		});

		await expect(picker.start("p1")).resolves.toBe(false);
		expect(picker.presetMin).toBe(30);
	});

	it("startet bei unlesbarer Uhrzeit nicht", async () => {
		const picker = new StartPicker();
		picker.customStart = "99:99";
		expect(picker.usingClock).toBe(true);
		expect(picker.hint).toBe("unlesbare Uhrzeit");
		await expect(picker.start("p1")).resolves.toBe(false);
		expect(appMock.startActivity).not.toHaveBeenCalled();
	});

	it("belegt die freie Uhrzeit vor und verwirft dabei das Preset", () => {
		const picker = new StartPicker();
		picker.choosePreset(60);
		picker.chooseClock();
		expect(picker.presetMin).toBe(0);
		expect(picker.customStart).toMatch(/^\d\d:\d\d$/);
	});
});
