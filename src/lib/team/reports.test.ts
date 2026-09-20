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

beforeEach(() => {
	uploadTeamReport.mockReset();
	loadTeamDevice.mockReset();
});

describe("uploadReportIfTeamMember", () => {
	it("tut ohne Team-Mitgliedschaft nichts", async () => {
		loadTeamDevice.mockResolvedValue(null);
		await uploadReportIfTeamMember("2026-08", {});
		expect(uploadTeamReport).not.toHaveBeenCalled();
	});

	it("lädt mit dem Token des Mitglieds hoch", async () => {
		loadTeamDevice.mockResolvedValue({ serverUrl: "https://tt.example.de", token: "tok" });
		await uploadReportIfTeamMember("2026-08", { a: 1 });
		expect(uploadTeamReport).toHaveBeenCalledWith("https://tt.example.de", "tok", "2026-08", { a: 1 });
	});

	it("wirft nicht, wenn der Upload scheitert", async () => {
		loadTeamDevice.mockResolvedValue({ serverUrl: "https://tt.example.de", token: "tok" });
		uploadTeamReport.mockRejectedValue(new Error("Netzwerk weg"));
		await expect(uploadReportIfTeamMember("2026-08", {})).resolves.toBeUndefined();
	});

	it("wirft nicht, wenn die Mitgliedschaft nicht lesbar ist", async () => {
		loadTeamDevice.mockRejectedValue(new Error("team.json beschädigt"));
		await expect(uploadReportIfTeamMember("2026-08", {})).resolves.toBeUndefined();
		expect(uploadTeamReport).not.toHaveBeenCalled();
	});
});
