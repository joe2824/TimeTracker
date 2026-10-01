// Jede Team-Anfrage gibt nach einem Zeitlimit auf - sonst hängt, was auf sie wartet.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchOwnTeamReport, fetchTeamActivities, TEAM_REQUEST_MS, uploadTeamReport } from "./api";
import { ApiError, type FetchFn } from "../sync/api";

/** Ein Server, der die Verbindung annimmt und nie antwortet. */
const silent: FetchFn = (_input, init) =>
	new Promise((_, reject) => {
		init?.signal?.addEventListener("abort", () => reject(new Error("abgebrochen")));
	});

beforeEach(() => {
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
});

describe("Zeitlimit", () => {
	it.each([
		["die Frage nach dem Bericht", () => fetchOwnTeamReport("https://tt.example.de", "tok", "2026-09", silent)],
		["der Abruf der Aktivitäten", () => fetchTeamActivities("https://tt.example.de", "tok", silent)],
		["der Upload des Berichts", () => uploadTeamReport("https://tt.example.de", "tok", "2026-09", {}, silent)]
	])("%s gibt auf, wenn der Server stumm bleibt", async (_name, request) => {
		const pending = request();
		const outcome = expect(pending).rejects.toMatchObject({ status: 0 });

		await vi.advanceTimersByTimeAsync(TEAM_REQUEST_MS);

		await outcome;
		await expect(pending).rejects.toBeInstanceOf(ApiError);
	});

	it("lässt eine Antwort vor Ablauf durch", async () => {
		const quick: FetchFn = async () => new Response(JSON.stringify({ submittedAt: 5 }), { status: 200 });

		await expect(fetchOwnTeamReport("https://tt.example.de", "tok", "2026-09", quick)).resolves.toEqual({
			submittedAt: 5
		});
		expect(vi.getTimerCount()).toBe(0);
	});
});
