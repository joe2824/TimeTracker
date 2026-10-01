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
let pending: PendingTeamReport[] = [];
vi.mock("../store", () => ({
	loadTeamDevice: () => loadTeamDevice(),
	loadPendingTeamReports: async () => pending,
	savePendingTeamReports: async (list: PendingTeamReport[]) => {
		pending = list;
	}
}));

const { retryTeamReportUploads, teamHasReport, teamReportPayload, uploadReportIfTeamMember } = await import("./reports");
const { ApiError } = await import("../sync/api");
import type { MonthReport } from "../report/report";
import type { PendingTeamReport } from "../store";

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
	pending = [];
});

const MEMBER = { teamMemberId: "m1", token: "tok", teamName: "Vertrieb", serverUrl: "https://tt.example.de" };

describe("Team-Upload nachholen", () => {
	it("merkt einen gescheiterten Upload vor", async () => {
		// Der Monat gilt danach als gesendet - ohne Vormerken fragte nichts mehr
		// nach, und beim Team stünde dauerhaft "kein Bericht".
		loadTeamDevice.mockResolvedValue(MEMBER);
		uploadTeamReport.mockRejectedValue(new ApiError("Server nicht erreichbar", 0));

		await uploadReportIfTeamMember("2026-08", REPORT);

		expect(pending).toEqual([{ month: "2026-08", teamMemberId: "m1", report: teamReportPayload(REPORT) }]);
	});

	it("merkt nichts vor, wenn der Server den Bericht ablehnt", async () => {
		// Ein zweiter Versuch mit demselben Inhalt scheiterte genauso.
		loadTeamDevice.mockResolvedValue(MEMBER);
		uploadTeamReport.mockRejectedValue(new ApiError("Ungültiger Bericht", 400));

		await uploadReportIfTeamMember("2026-08", REPORT);

		expect(pending).toEqual([]);
	});

	it("holt einen vorgemerkten Upload nach und streicht ihn", async () => {
		loadTeamDevice.mockResolvedValue(MEMBER);
		pending = [{ month: "2026-08", teamMemberId: "m1", report: teamReportPayload(REPORT) }];
		uploadTeamReport.mockResolvedValue({ ok: true });

		await retryTeamReportUploads();

		expect(uploadTeamReport).toHaveBeenCalledWith("https://tt.example.de", "tok", "2026-08", teamReportPayload(REPORT));
		expect(pending).toEqual([]);
	});

	it("lässt vorgemerkt, was erneut scheitert", async () => {
		loadTeamDevice.mockResolvedValue(MEMBER);
		pending = [{ month: "2026-08", teamMemberId: "m1", report: teamReportPayload(REPORT) }];
		uploadTeamReport.mockRejectedValue(new ApiError("Server nicht erreichbar", 0));

		await retryTeamReportUploads();

		expect(pending).toHaveLength(1);
	});

	it("verwirft Vorgemerktes einer anderen Mitgliedschaft, ohne es hochzuladen", async () => {
		// Nach Austritt und neuem Beitritt landete der alte Bericht sonst beim falschen Team.
		loadTeamDevice.mockResolvedValue(MEMBER);
		pending = [{ month: "2026-08", teamMemberId: "frueher", report: teamReportPayload(REPORT) }];

		await retryTeamReportUploads();

		expect(uploadTeamReport).not.toHaveBeenCalled();
		expect(pending).toEqual([]);
	});

	it("ein geglückter Upload streicht den älteren Vormerk desselben Monats", async () => {
		loadTeamDevice.mockResolvedValue(MEMBER);
		pending = [{ month: "2026-08", teamMemberId: "m1", report: { rows: [], total: 0, workHours: 0, absenceHours: 0 } }];
		uploadTeamReport.mockResolvedValue({ ok: true });

		await uploadReportIfTeamMember("2026-08", REPORT);

		expect(pending).toEqual([]);
	});
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
