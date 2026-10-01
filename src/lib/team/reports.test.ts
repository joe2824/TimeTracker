// Der Team-Upload darf nie den Mail-Versand kippen, auch nicht durch einen
// Lesefehler beim Nachsehen der Mitgliedschaft.
import { beforeEach, describe, expect, it, vi } from "vitest";

const uploadTeamReport = vi.fn();
const fetchOwnTeamReport = vi.fn();
const loadTeamDevice = vi.fn();
vi.mock("./api", () => ({
	uploadTeamReport: (...args: unknown[]) => uploadTeamReport(...args),
	fetchOwnTeamReport: (...args: unknown[]) => fetchOwnTeamReport(...args)
}));
vi.mock("../store", () => ({
	loadTeamDevice: () => loadTeamDevice()
}));

const { teamHasReport, uploadReportIfTeamMember } = await import("./reports");
import type { MonthReport } from "../report/report";

const REPORT: MonthReport = {
	month: "2026-08",
	label: "August 2026",
	rows: [
		{ activityId: "a", name: "Projekt A", hours: 7.5, isAbsence: false },
		{ activityId: "b", name: "Privates Projekt", hours: 0, isAbsence: false },
		{ activityId: "k", name: "Krank", hours: 8, isAbsence: true }
	],
	total: 15.5,
	absenceHours: 8,
	workHours: 7.5,
	timeOffHours: 0,
	breakHours: 1
};

beforeEach(() => {
	uploadTeamReport.mockReset();
	fetchOwnTeamReport.mockReset();
	loadTeamDevice.mockReset();
});

describe("uploadReportIfTeamMember", () => {
	it("tut ohne Team-Mitgliedschaft nichts", async () => {
		loadTeamDevice.mockResolvedValue(null);
		await uploadReportIfTeamMember("2026-08", REPORT);
		expect(uploadTeamReport).not.toHaveBeenCalled();
	});

	it("lädt mit dem Token des Mitglieds nur Zeilen mit Stunden und die Summen hoch", async () => {
		loadTeamDevice.mockResolvedValue({ serverUrl: "https://tt.example.de", token: "tok" });
		await uploadReportIfTeamMember("2026-08", REPORT);
		expect(uploadTeamReport).toHaveBeenCalledWith("https://tt.example.de", "tok", "2026-08", {
			rows: [
				{ name: "Projekt A", hours: 7.5, isAbsence: false },
				{ name: "Krank", hours: 8, isAbsence: true }
			],
			total: 15.5,
			workHours: 7.5,
			absenceHours: 8
		});
	});

	it("wirft nicht, wenn der Upload scheitert", async () => {
		loadTeamDevice.mockResolvedValue({ serverUrl: "https://tt.example.de", token: "tok" });
		uploadTeamReport.mockRejectedValue(new Error("Netzwerk weg"));
		await expect(uploadReportIfTeamMember("2026-08", REPORT)).resolves.toBeUndefined();
	});

	it("wirft nicht, wenn die Mitgliedschaft nicht lesbar ist", async () => {
		loadTeamDevice.mockRejectedValue(new Error("team.json beschädigt"));
		await expect(uploadReportIfTeamMember("2026-08", REPORT)).resolves.toBeUndefined();
		expect(uploadTeamReport).not.toHaveBeenCalled();
	});
});

describe("teamHasReport", () => {
	const DEVICE = { teamMemberId: "m1", token: "team-tok", teamName: "Vertrieb", serverUrl: "https://tt.example.de" };

	it("weiss ohne Team-Mitgliedschaft nichts und fragt niemanden", async () => {
		loadTeamDevice.mockResolvedValue(null);
		expect(await teamHasReport("2026-09")).toBeNull();
		expect(fetchOwnTeamReport).not.toHaveBeenCalled();
	});

	it("meldet einen vorliegenden und einen fehlenden Bericht", async () => {
		loadTeamDevice.mockResolvedValue(DEVICE);
		fetchOwnTeamReport.mockResolvedValueOnce({ submittedAt: 1_790_000_000_000 });
		expect(await teamHasReport("2026-09")).toBe(true);
		expect(fetchOwnTeamReport).toHaveBeenCalledWith("https://tt.example.de", "team-tok", "2026-09");

		fetchOwnTeamReport.mockResolvedValueOnce({ submittedAt: null });
		expect(await teamHasReport("2026-09")).toBe(false);
	});

	it("laesst die Frage offen, wenn der Server nicht antwortet oder die Abfrage nicht kennt", async () => {
		loadTeamDevice.mockResolvedValue(DEVICE);
		fetchOwnTeamReport.mockRejectedValue(new Error("405"));
		expect(await teamHasReport("2026-09")).toBeNull();
	});
});
