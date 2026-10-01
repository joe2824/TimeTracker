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
let teamFilePresent = false;
vi.mock("../store", () => ({
	loadTeamDevice: () => loadTeamDevice(),
	teamFileExists: async () => teamFilePresent,
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
	teamFilePresent = false;
});

const MEMBER = { teamMemberId: "m1", token: "tok", teamName: "Vertrieb", serverUrl: "https://tt.example.de" };
/** Wann der vorgemerkte Bericht entstand. */
const QUEUED_AT = 1_790_000_000_000;

describe("Team-Upload nachholen", () => {
	beforeEach(() => {
		fetchOwnTeamReport.mockResolvedValue({ submittedAt: null });
	});

	it("verwirft Vorgemerktes, wenn beim Team schon ein jüngerer Bericht liegt", async () => {
		// Der Monat wurde inzwischen von einem anderen Gerät korrigiert und neu
		// gesendet - der alte Stand von hier überschriebe ihn sonst.
		loadTeamDevice.mockResolvedValue(MEMBER);
		pending = [{ month: "2026-08", teamMemberId: "m1", report: teamReportPayload(REPORT), at: QUEUED_AT }];
		fetchOwnTeamReport.mockResolvedValue({ submittedAt: QUEUED_AT + 60_000 });

		await retryTeamReportUploads();

		expect(uploadTeamReport).not.toHaveBeenCalled();
		expect(pending).toEqual([]);
	});

	it("reicht nach, wenn beim Team nur ein älterer Bericht liegt", async () => {
		loadTeamDevice.mockResolvedValue(MEMBER);
		pending = [{ month: "2026-08", teamMemberId: "m1", report: teamReportPayload(REPORT), at: QUEUED_AT }];
		fetchOwnTeamReport.mockResolvedValue({ submittedAt: QUEUED_AT - 60_000 });
		uploadTeamReport.mockResolvedValue({ ok: true });

		await retryTeamReportUploads();

		expect(uploadTeamReport).toHaveBeenCalledTimes(1);
		expect(pending).toEqual([]);
	});

	it("wartet mit dem Nachreichen, solange sich der Stand beim Team nicht erfragen lässt", async () => {
		loadTeamDevice.mockResolvedValue(MEMBER);
		pending = [{ month: "2026-08", teamMemberId: "m1", report: teamReportPayload(REPORT), at: QUEUED_AT }];
		fetchOwnTeamReport.mockRejectedValue(new ApiError("Server nicht erreichbar", 0));

		await retryTeamReportUploads();

		expect(uploadTeamReport).not.toHaveBeenCalled();
		expect(pending).toHaveLength(1);
	});

	it("reicht nach, wenn der Server die Frage nach dem Stand nicht kennt", async () => {
		// Ein älterer Server ohne diese Abfrage: dann wie zuvor ohne Prüfung.
		loadTeamDevice.mockResolvedValue(MEMBER);
		pending = [{ month: "2026-08", teamMemberId: "m1", report: teamReportPayload(REPORT), at: QUEUED_AT }];
		fetchOwnTeamReport.mockRejectedValue(new ApiError("Method Not Allowed", 405));
		uploadTeamReport.mockResolvedValue({ ok: true });

		await retryTeamReportUploads();

		expect(uploadTeamReport).toHaveBeenCalledTimes(1);
	});

	it("merkt vor, wenn die Absage nicht vom Server selbst stammt", async () => {
		// Ein Proxy davor antwortet etwa mit 403 - der Bericht ist damit nicht abgelehnt.
		loadTeamDevice.mockResolvedValue(MEMBER);
		uploadTeamReport.mockRejectedValue(new ApiError("Forbidden", 403));

		await uploadReportIfTeamMember("2026-08", REPORT);

		expect(pending).toHaveLength(1);
	});

	it("merkt einen gescheiterten Upload vor", async () => {
		// Der Monat gilt danach als gesendet - ohne Vormerken fragte nichts mehr
		// nach, und beim Team stünde dauerhaft "kein Bericht".
		loadTeamDevice.mockResolvedValue(MEMBER);
		uploadTeamReport.mockRejectedValue(new ApiError("Server nicht erreichbar", 0));

		await uploadReportIfTeamMember("2026-08", REPORT);

		expect(pending).toEqual([
			{ month: "2026-08", teamMemberId: "m1", report: teamReportPayload(REPORT), at: expect.any(Number) }
		]);
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
		pending = [{ month: "2026-08", teamMemberId: "m1", report: teamReportPayload(REPORT), at: QUEUED_AT }];
		uploadTeamReport.mockResolvedValue({ ok: true });

		await retryTeamReportUploads();

		expect(uploadTeamReport).toHaveBeenCalledWith("https://tt.example.de", "tok", "2026-08", teamReportPayload(REPORT));
		expect(pending).toEqual([]);
	});

	it("lässt vorgemerkt, was erneut scheitert", async () => {
		loadTeamDevice.mockResolvedValue(MEMBER);
		pending = [{ month: "2026-08", teamMemberId: "m1", report: teamReportPayload(REPORT), at: QUEUED_AT }];
		uploadTeamReport.mockRejectedValue(new ApiError("Server nicht erreichbar", 0));

		await retryTeamReportUploads();

		expect(pending).toHaveLength(1);
	});

	it("verwirft Vorgemerktes einer anderen Mitgliedschaft, ohne es hochzuladen", async () => {
		// Nach Austritt und neuem Beitritt landete der alte Bericht sonst beim falschen Team.
		loadTeamDevice.mockResolvedValue(MEMBER);
		pending = [{ month: "2026-08", teamMemberId: "frueher", report: teamReportPayload(REPORT), at: QUEUED_AT }];

		await retryTeamReportUploads();

		expect(uploadTeamReport).not.toHaveBeenCalled();
		expect(pending).toEqual([]);
	});

	it("behält Vorgemerktes, solange die Mitgliedschaft nur nicht lesbar ist", async () => {
		loadTeamDevice.mockResolvedValue(null);
		teamFilePresent = true;
		pending = [{ month: "2026-08", teamMemberId: "m1", report: teamReportPayload(REPORT), at: QUEUED_AT }];

		await retryTeamReportUploads();

		expect(pending).toHaveLength(1);
	});

	it("ein geglückter Upload streicht den älteren Vormerk desselben Monats", async () => {
		loadTeamDevice.mockResolvedValue(MEMBER);
		pending = [{ month: "2026-08", teamMemberId: "m1", report: { rows: [], total: 0, workHours: 0, absenceHours: 0 }, at: QUEUED_AT }];
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
