import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Activity, Entry } from "./types";
import { defaultSettings } from "./types";
import { files, resetFakeFs } from "./testing/fakeFs";

vi.mock("@tauri-apps/plugin-fs", async () => (await import("./testing/fakeFs")).fakeFs);
vi.mock("svelte-sonner", () => ({
	toast: Object.assign(vi.fn(), { info() {}, error() {}, success() {}, warning() {} })
}));

// Mit ausgeschriebenen Parametern: sonst haelt TypeScript die Aufrufliste des
// Mocks fuer leer, und jeder Zugriff auf ein Argument ist ein Typfehler.
const outlook = vi.hoisted(() => ({
	createOutlookDraft: vi.fn(async (_to: string, _subject: string, _htmlBody: string) => "ok")
}));
vi.mock("./outlook", () => ({ createOutlookDraft: outlook.createOutlookDraft }));

const { app } = await import("./app.svelte");
const { reportSubject, sendReport } = await import("./reportSend");

const P1 = "p1";
const AKTIVITAETEN: Activity[] = [
	{ id: P1, name: "Projekt 1", sortOrder: 0, archived: false, isAbsence: false }
];

const at = (tag: number, h: number, min = 0) => new Date(2026, 6, tag, h, min, 0, 0).getTime();

function eintrag(id: string, startTs: number, endTs: number): Entry {
	return { id, activityId: P1, startTs, endTs, note: "", source: "timer" };
}

beforeEach(() => {
	resetFakeFs();
	app.dispose();
	app.settings = { ...defaultSettings, bossEmail: "chef@firma.de", senderName: "Anna" };
	app.activities = [...AKTIVITAETEN];
	app.running = null;
	app.entriesByMonth = {};
	outlook.createOutlookDraft.mockClear();
});

describe("reportSubject", () => {
	it("setzt Monat und Namen aus den Einstellungen ein", () => {
		app.settings.reportSubjectTemplate = "Stundenerfassung {month} – {name}";
		expect(reportSubject("Juli 2026")).toBe("Stundenerfassung Juli 2026 – Anna");
	});

	it("haengt den Namen an, wenn die Vorlage ihn verloren hat", () => {
		app.settings.reportSubjectTemplate = "Stundenerfassung {month}";
		expect(reportSubject("Juli 2026")).toBe("Stundenerfassung Juli 2026 – Anna");
	});

	it("laesst ohne Namen keinen leeren Trenner stehen", () => {
		app.settings.senderName = "";
		app.settings.reportSubjectTemplate = "Stundenerfassung {month} – {name}";
		expect(reportSubject("Juli 2026")).toBe("Stundenerfassung Juli 2026");
	});
});

describe("sendReport", () => {
	it("oeffnet den Entwurf mit Empfaenger, Betreff und Tabelle", async () => {
		app.entriesByMonth["2026-07"] = [eintrag("e1", at(16, 9), at(16, 12))];

		await sendReport("2026-07");

		expect(outlook.createOutlookDraft).toHaveBeenCalledTimes(1);
		const [to, subject, html] = outlook.createOutlookDraft.mock.calls[0];
		expect(to).toBe("chef@firma.de");
		expect(subject).toContain("Juli 2026");
		expect(html).toContain("Projekt 1");
		expect(html).toContain("<table");
	});

	it("markiert den Monat erst nach dem Entwurf als erledigt", async () => {
		app.entriesByMonth["2026-07"] = [eintrag("e1", at(16, 9), at(16, 12))];

		await sendReport("2026-07");

		expect(app.isReportSent("2026-07")).toBe(true);
		// Und dauerhaft, nicht nur im Speicher.
		expect(JSON.parse(files.get("data/settings.json") ?? "{}").reportSentMonths).toContain(
			"2026-07"
		);
	});

	it("laesst den Monat offen, wenn Outlook nicht mitspielt", async () => {
		// Sonst gilt ein Bericht als verschickt, den niemand je gesehen hat – und die
		// Erinnerung kommt nicht wieder.
		app.entriesByMonth["2026-07"] = [eintrag("e1", at(16, 9), at(16, 12))];
		outlook.createOutlookDraft.mockRejectedValueOnce(new Error("Outlook antwortet nicht"));

		await expect(sendReport("2026-07")).rejects.toThrow("Outlook antwortet nicht");

		expect(app.isReportSent("2026-07")).toBe(false);
	});

	it("laedt den Monat nach, wenn er noch nicht im Speicher steht", async () => {
		// Der Bericht laesst sich fuer einen Monat ausloesen, den die App in dieser
		// Sitzung nie geoeffnet hat. Ohne das Nachladen stuende dort eine leere
		// Tabelle – ein Bericht ueber einen Monat ohne Arbeit.
		files.set("data/entries-2026-07.json", JSON.stringify([eintrag("e1", at(16, 9), at(16, 12))]));

		await sendReport("2026-07");

		const html = outlook.createOutlookDraft.mock.calls[0][2];
		expect(html).toContain("3:00");
	});
});
