import { describe, expect, it } from "vitest";
import { defaultSettings } from "../types";
import { stampFields as stampWith } from "./fieldMerge";
import { mergeSettings, SETTINGS_FIELDS, type StampedSettings } from "./settingsMerge";

const stampFields = (before: StampedSettings | null, after: StampedSettings, now: number) =>
	stampWith(before, after, now, SETTINGS_FIELDS);

const T1 = 1_000;
const T2 = 2_000;
const NOW = 9_000;

const settings = (over: Partial<StampedSettings> = {}): StampedSettings => ({ ...defaultSettings, ...over });

describe("stampFields", () => {
	it("stempelt nur, was sich geändert hat", () => {
		const before = settings({ updatedAt: T1, fieldUpdatedAt: { bossEmail: T1 } });
		const after = { ...before, senderName: "Anna Meier" };

		const stamps = stampFields(before, after, NOW).fieldUpdatedAt!;

		expect(stamps.senderName).toBe(NOW);
		expect(stamps.bossEmail).toBe(T1);
		expect(stamps.usageLastDay).toBeUndefined();
	});

	it("ein Stand ohne Feldstempel gibt jedem Feld die Zeit seines Datensatzes", () => {
		// Stand einer älteren Fassung: seine Felder sind so alt wie er, nicht neu.
		const before = settings({ updatedAt: T1, bossEmail: "anna.meier@firma.de" });
		const after = { ...before, usageLastDay: "2026-10-05" };

		const stamps = stampFields(before, after, NOW).fieldUpdatedAt!;

		expect(stamps.bossEmail).toBe(T1);
		expect(stamps.usageLastDay).toBe(NOW);
	});

	it("ein Feld, das eine neue Fassung mit Voreinstellung nachträgt, gilt nicht als geändert", () => {
		// Sonst schöbe jedes Gerät nach einem Update die Voreinstellung über
		// das, was auf einem anderen Gerät schon eingestellt wurde.
		const { bossMode: _, ...older } = settings({ updatedAt: T1, fieldUpdatedAt: {} });
		const after = settings({ updatedAt: T1, fieldUpdatedAt: {} });

		expect(stampFields(older as StampedSettings, after, NOW).fieldUpdatedAt!.bossMode).toBeUndefined();
	});

	it("auf einem frischen Gerät zählt nur, was von der Voreinstellung abweicht", () => {
		const stamps = stampFields(null, settings({ usageLastDay: "2026-10-05" }), NOW).fieldUpdatedAt!;
		expect(stamps).toEqual({ usageLastDay: NOW });
	});

	it("behält einen mitgebrachten jüngeren Stempel", () => {
		// Der Abgleich legt Zusammengeführtes mit den Stempeln des anderen Geräts ab.
		const before = settings({ updatedAt: T1, fieldUpdatedAt: { bossEmail: T1 } });
		const after = settings({ bossEmail: "anna.meier@firma.de", fieldUpdatedAt: { bossEmail: T2 } });

		expect(stampFields(before, after, NOW).fieldUpdatedAt!.bossEmail).toBe(T2);
	});
});

describe("mergeSettings", () => {
	it("nimmt je Feld die jüngere Änderung", () => {
		const local = settings({
			updatedAt: T2,
			bossEmail: "",
			usageLastDay: "2026-10-05",
			fieldUpdatedAt: { usageLastDay: T2 }
		});
		const remote = settings({
			updatedAt: T1,
			rev: 4,
			bossEmail: "anna.meier@firma.de",
			usageLastDay: "2026-10-01",
			fieldUpdatedAt: { bossEmail: T1, usageLastDay: T1 - 1 }
		});

		const merged = mergeSettings(local, remote);

		expect(merged.bossEmail).toBe("anna.meier@firma.de");
		expect(merged.usageLastDay).toBe("2026-10-05");
		expect(merged.fieldUpdatedAt).toEqual({ bossEmail: T1, usageLastDay: T2 });
		expect(merged.rev).toBe(4);
		expect(merged.updatedAt).toBe(T2);
	});

	it("zwei Stände ohne Feldstempel entscheidet der Datensatz als Ganzes", () => {
		const local = settings({ updatedAt: T1, bossEmail: "alt@firma.de" });
		const remote = settings({ updatedAt: T2, bossEmail: "neu@firma.de" });

		expect(mergeSettings(local, remote).bossEmail).toBe("neu@firma.de");
		expect(mergeSettings(remote, local).bossEmail).toBe("neu@firma.de");
	});

	it("vereinigt die Gesendet-Vermerke, gleich wer gewinnt", () => {
		const local = settings({ updatedAt: T1, reportSentMonths: ["2026-08"], fieldUpdatedAt: { reportSentMonths: T1 } });
		const remote = settings({ updatedAt: T2, reportSentMonths: ["2026-09"], fieldUpdatedAt: { reportSentMonths: T2 } });

		expect(mergeSettings(local, remote).reportSentMonths).toEqual(["2026-08", "2026-09"]);
	});

	it("vereinigt Stichwort-Zuordnungen und abgelehnte Zusammenführungen zweier Geräte", () => {
		// Beide wachsen nur: was ein Gerät dazulernt, darf das andere nicht verdrängen.
		const local = settings({
			updatedAt: T1,
			calendarKeywordMap: { standup: "a1", review: "a2" },
			teamMergeDeclined: ["x"],
			fieldUpdatedAt: { calendarKeywordMap: T1, teamMergeDeclined: T1 }
		});
		const remote = settings({
			updatedAt: T2,
			calendarKeywordMap: { review: "a3", planung: "a4" },
			teamMergeDeclined: ["y"],
			fieldUpdatedAt: { calendarKeywordMap: T2, teamMergeDeclined: T2 }
		});

		const merged = mergeSettings(local, remote);

		expect(merged.calendarKeywordMap).toEqual({ standup: "a1", review: "a3", planung: "a4" });
		expect(merged.teamMergeDeclined).toEqual(["x", "y"]);
	});
});
