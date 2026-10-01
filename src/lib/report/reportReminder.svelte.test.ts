// Wann die Berichts-Erinnerung fällig ist - Dialog und Tray-Badge fragen dasselbe.
import { beforeEach, describe, expect, it, vi } from "vitest";

const appMock = vi.hoisted(() => ({
	pendingReportMonth: "2026-09" as string | null,
	settings: { reportReminderEnabled: true },
	markReportSent: vi.fn()
}));
vi.mock("../app.svelte", () => ({ app: appMock }));

const accountMock = vi.hoisted(() => ({ linked: false, firstSyncDone: false }));
vi.mock("../sync/account.svelte", () => ({ account: accountMock }));

const watchersMock = vi.hoisted(() => ({ forceReportReminder: false, reportReminderDismissed: false }));
vi.mock("../ui/watchers.svelte", () => ({ watchers: watchersMock }));

const teamHasReport = vi.fn();
vi.mock("../team/reports", () => ({ teamHasReport: (...args: unknown[]) => teamHasReport(...args) }));

const confirmReportSent = vi.fn();
vi.mock("./reportSend", () => ({ confirmReportSent: (...args: unknown[]) => confirmReportSent(...args) }));

const { ReportReminder } = await import("./reportReminder.svelte");

beforeEach(() => {
	appMock.pendingReportMonth = "2026-09";
	appMock.settings.reportReminderEnabled = true;
	appMock.markReportSent.mockReset();
	appMock.markReportSent.mockImplementation(async () => {
		appMock.pendingReportMonth = null;
	});
	accountMock.linked = false;
	accountMock.firstSyncDone = false;
	watchersMock.forceReportReminder = false;
	watchersMock.reportReminderDismissed = false;
	teamHasReport.mockReset();
	confirmReportSent.mockReset();
});

describe("ReportReminder", () => {
	it("ist erst fällig, wenn die Frage ans Team beantwortet ist", async () => {
		// Sonst leuchtete das Tray-Badge, ohne dass ein Dialog dahinter steht.
		const reminder = new ReportReminder();
		teamHasReport.mockResolvedValue(null);
		expect(reminder.due).toBe(false);

		await reminder.checkTeam();

		expect(reminder.due).toBe(true);
	});

	it("vermerkt den Monat, statt zu fragen, wenn der Bericht beim Team liegt", async () => {
		const reminder = new ReportReminder();
		teamHasReport.mockResolvedValue(true);

		await reminder.checkTeam();

		expect(appMock.markReportSent).toHaveBeenCalledWith("2026-09");
		expect(reminder.due).toBe(false);
	});

	it("fragt wie gewohnt, wenn das Vermerken scheitert", async () => {
		// Ohne das bliebe die Erinnerung für den ganzen Lauf aus.
		const reminder = new ReportReminder();
		teamHasReport.mockResolvedValue(true);
		appMock.markReportSent.mockRejectedValue(new Error("Einstellungen nicht schreibbar"));

		await expect(reminder.checkTeam()).resolves.toBeUndefined();

		expect(reminder.due).toBe(true);
	});

	it("fragt das Team je Monat nur einmal", async () => {
		const reminder = new ReportReminder();
		teamHasReport.mockResolvedValue(false);

		await Promise.all([reminder.checkTeam(), reminder.checkTeam()]);
		await reminder.checkTeam();

		expect(teamHasReport).toHaveBeenCalledTimes(1);
	});

	it("wartet mit der Frage, bis ein verknüpftes Gerät abgeglichen hat", async () => {
		accountMock.linked = true;
		const reminder = new ReportReminder();

		await reminder.checkTeam();
		expect(teamHasReport).not.toHaveBeenCalled();
		expect(reminder.due).toBe(false);

		accountMock.firstSyncDone = true;
		teamHasReport.mockResolvedValue(false);
		await reminder.checkTeam();
		expect(reminder.due).toBe(true);
	});

	it("„Schon gesendet“ schliesst die Erinnerung", async () => {
		const reminder = new ReportReminder();
		confirmReportSent.mockResolvedValue(undefined);

		await expect(reminder.confirmSent()).resolves.toBe(true);

		expect(confirmReportSent).toHaveBeenCalledWith("2026-09");
		expect(watchersMock.reportReminderDismissed).toBe(true);
	});

	it("„Schon gesendet“ lässt die Erinnerung offen, wenn das Vermerken scheitert", async () => {
		const reminder = new ReportReminder();
		confirmReportSent.mockRejectedValue(new Error("Monat nicht lesbar"));

		await expect(reminder.confirmSent()).resolves.toBe(false);

		expect(watchersMock.reportReminderDismissed).toBe(false);
	});
});
