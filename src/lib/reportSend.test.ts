// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Activity, Entry } from "./types";
import { defaultSettings } from "./types";
import { files, resetFakeFs } from "./testing/fakeFs";

vi.mock("@tauri-apps/plugin-fs", async () => (await import("./testing/fakeFs")).fakeFs);
vi.mock("svelte-sonner", () => ({
	toast: Object.assign(vi.fn(), {
		info() {},
		error() {},
		success() {},
		warning() {}
	})
}));

// Mit ausgeschriebenen Parametern: sonst haelt TypeScript die Aufrufliste des
// Mocks fuer leer, und jeder Zugriff auf ein Argument ist ein Typfehler.
const outlook = vi.hoisted(() => ({
	createOutlookDraft: vi.fn(async (_to: string, _subject: string, _htmlBody: string) => "ok")
}));
vi.mock("./outlook", () => ({
	createOutlookDraft: outlook.createOutlookDraft,
	mailtoFallback: (to: string, subject: string, body: string) =>
		`mailto:${encodeURIComponent(to)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`
}));

const opener = vi.hoisted(() => ({
	openExternal: vi.fn(async (_url: string) => {})
}));
vi.mock("./platform/open", () => ({ openExternal: opener.openExternal }));

const { app } = await import("./app.svelte");
const { PASTE_HINT, reportSubject, sendReport } = await import("./reportSend");

const P1 = "p1";
const ACTIVITIES_DE: Activity[] = [
	{
		id: P1,
		name: "Projekt 1",
		sortOrder: 0,
		archived: false,
		isAbsence: false
	}
];

const at = (tag: number, h: number, min = 0) => new Date(2026, 6, tag, h, min, 0, 0).getTime();

function entry(id: string, startTs: number, endTs: number): Entry {
	return { id, activityId: P1, startTs, endTs, note: "", source: "timer" };
}

/** Was in der Zwischenablage landete, oder null wenn sie nicht ging. */
let clipboard: { html: string; text: string } | null = null;

/** Desktop vortaeuschen: `capabilities.outlook` haengt an __TAURI_INTERNALS__. */
function pretendDesktop(on: boolean) {
	if (on) (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
	else delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
}

/** Zwischenablage, die nichts annimmt (happy-dom bringt keine mit). */
function breakClipboard() {
	delete (globalThis as unknown as Record<string, unknown>).ClipboardItem;
	Object.defineProperty(navigator, "clipboard", {
		configurable: true,
		value: {
			write: () => Promise.reject(new Error("keine Zwischenablage")),
			writeText: () => Promise.reject(new Error("keine Zwischenablage"))
		}
	});
}

/** Eine Zwischenablage, die den text/html-Flavor kann. */
function fakeClipboard() {
	class FakeClipboardItem {
		constructor(readonly items: Record<string, Blob>) {}
	}
	(globalThis as unknown as Record<string, unknown>).ClipboardItem = FakeClipboardItem;
	Object.defineProperty(navigator, "clipboard", {
		configurable: true,
		value: {
			async write(items: FakeClipboardItem[]) {
				clipboard = {
					html: await items[0].items["text/html"].text(),
					text: await items[0].items["text/plain"].text()
				};
			}
		}
	});
}

beforeEach(() => {
	resetFakeFs();
	app.dispose();
	app.settings = {
		...defaultSettings,
		bossEmail: "chef@firma.de",
		senderName: "Anna"
	};
	app.activities = [...ACTIVITIES_DE];
	app.running = null;
	app.entriesByMonth = {};
	outlook.createOutlookDraft.mockClear();
	opener.openExternal.mockClear();
	clipboard = null;
	breakClipboard();
	pretendDesktop(true);
});

afterEach(() => {
	pretendDesktop(false);
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
		app.entriesByMonth["2026-07"] = [entry("e1", at(16, 9), at(16, 12))];

		await sendReport("2026-07");

		expect(outlook.createOutlookDraft).toHaveBeenCalledTimes(1);
		const [to, subject, html] = outlook.createOutlookDraft.mock.calls[0];
		expect(to).toBe("chef@firma.de");
		expect(subject).toContain("Juli 2026");
		expect(html).toContain("Projekt 1");
		expect(html).toContain("<table");
	});

	it("markiert den Monat erst nach dem Entwurf als erledigt", async () => {
		app.entriesByMonth["2026-07"] = [entry("e1", at(16, 9), at(16, 12))];

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
		app.entriesByMonth["2026-07"] = [entry("e1", at(16, 9), at(16, 12))];
		outlook.createOutlookDraft.mockRejectedValueOnce(new Error("Outlook antwortet nicht"));

		await expect(sendReport("2026-07")).rejects.toThrow("Outlook antwortet nicht");

		expect(app.isReportSent("2026-07")).toBe(false);
	});

	it("laedt den Monat nach, wenn er noch nicht im Speicher steht", async () => {
		// Der Bericht laesst sich fuer einen Monat ausloesen, den die App in dieser
		// Sitzung nie geoeffnet hat. Ohne das Nachladen stuende dort eine leere
		// Tabelle – ein Bericht ueber einen Monat ohne Arbeit.
		files.set("data/entries-2026-07.json", JSON.stringify([entry("e1", at(16, 9), at(16, 12))]));

		await sendReport("2026-07");

		const html = outlook.createOutlookDraft.mock.calls[0][2];
		expect(html).toContain("3:00");
	});
});

describe("sendReport ohne Outlook", () => {
	// Im Browser gibt es keinen COM-Entwurf. mailto kann nur reinen Text, die
	// Tabelle muss also ueber die Zwischenablage kommen.
	beforeEach(() => {
		pretendDesktop(false);
		app.entriesByMonth["2026-07"] = [entry("e1", at(16, 9), at(16, 12))];
	});

	it("legt die Tabelle in die Zwischenablage und oeffnet die Mail leer", async () => {
		fakeClipboard();

		const res = await sendReport("2026-07");

		expect(res).toEqual({ via: "mail", clipboard: "rich" });
		expect(outlook.createOutlookDraft).not.toHaveBeenCalled();
		expect(clipboard?.html).toContain("<table");
		expect(clipboard?.html).toContain("Projekt 1");
		// Im Body steht nur die Anleitung: die Liste zusaetzlich hineinzuschreiben
		// haette sie doppelt in der Mail, sobald jemand die Tabelle einfuegt.
		const url = opener.openExternal.mock.calls[0][0];
		expect(url).toContain("mailto:chef%40firma.de");
		expect(url).toContain("subject=");
		const body = new URL(url).searchParams.get("body");
		expect(body).toBe(PASTE_HINT);
		expect(body).not.toContain("Projekt 1");
		expect(app.isReportSent("2026-07")).toBe(true);
	});

	it("nimmt den Text in die Mail, wenn die Zwischenablage nicht geht", async () => {
		const res = await sendReport("2026-07");

		expect(res).toEqual({ via: "mail", clipboard: null });
		expect(new URL(opener.openExternal.mock.calls[0][0]).searchParams.get("body")).toContain(
			"Projekt 1"
		);
	});

	it("laesst den Monat offen, wenn sich das Mailprogramm nicht oeffnen laesst", async () => {
		opener.openExternal.mockRejectedValueOnce(new Error("kein Mailprogramm"));

		await expect(sendReport("2026-07")).rejects.toThrow("kein Mailprogramm");

		expect(app.isReportSent("2026-07")).toBe(false);
	});
});
