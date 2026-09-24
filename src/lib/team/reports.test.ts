// Der Team-Upload darf nie den Mail-Versand kippen, auch nicht durch einen
// Lesefehler beim Nachsehen der Mitgliedschaft.
import { beforeEach, describe, expect, it, vi } from "vitest";

const uploadTeamReport = vi.fn();
const loadTeamDevice = vi.fn();
vi.mock("./api", () => ({
	uploadTeamReport: (...args: unknown[]) => uploadTeamReport(...args)
}));
vi.mock("../store", () => ({
	loadTeamDevice: () => loadTeamDevice()
}));

const { uploadReportIfTeamMember } = await import("./reports");
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
