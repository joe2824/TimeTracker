// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const isTauri = vi.fn(() => true);
vi.mock("./platform/env", () => ({ isTauri: () => isTauri() }));

const { CURRENT_RELEASE, whatsNew } = await import("./whatsNew.svelte");

const KEY = "timetracker:last_seen_release";

beforeEach(() => {
	vi.useFakeTimers();
	localStorage.clear();
	isTauri.mockReturnValue(true);
	whatsNew.isOpen = false;
});

afterEach(() => vi.useRealTimers());

/** Startlauf durchspielen und zurueckgeben, ob der Dialog aufgegangen ist. */
function startup(isFirstAppStart = false): boolean {
	whatsNew.checkOnStartup(isFirstAppStart);
	vi.advanceTimersByTime(1000);
	return whatsNew.isOpen;
}

describe("checkOnStartup", () => {
	it("zeigt den Dialog, wenn diese Release-Fassung noch nicht gesehen wurde", () => {
		localStorage.setItem(KEY, "0.8.0");
		expect(startup()).toBe(true);
	});

	it("zeigt ihn nicht noch einmal, wenn dieselbe Fassung schon gesehen wurde", () => {
		localStorage.setItem(KEY, CURRENT_RELEASE.version);
		expect(startup()).toBe(false);
	});

	it("zeigt ihn nach einem Bugfix-Release nicht erneut", () => {
		// Der Kern der Sache: CURRENT_RELEASE.version gehoert zum INHALT, nicht zur
		// App-Version. Wird sie bei einem Release ohne neuen Text mitgezogen,
		// bekommt jeder denselben Dialog ein zweites Mal.
		localStorage.setItem(KEY, "0.9.0");
		expect(CURRENT_RELEASE.version).toBe("0.9.0");
		expect(startup()).toBe(false);
	});

	it("zeigt ihn nicht, wenn schon eine SPAETERE Fassung gesehen wurde", () => {
		// Der Fall nach dem Zurueckstellen der Nummer: wer 0.9.1 bereits weggeklickt
		// hat, kennt diesen Inhalt. Ein Vergleich auf Ungleichheit zeigte ihn erneut.
		localStorage.setItem(KEY, "0.9.1");
		expect(startup()).toBe(false);
	});

	it("zeigt ihn auch nach einer Vorabfassung derselben Nummer nicht", () => {
		localStorage.setItem(KEY, "0.9.0-beta.3");
		expect(startup()).toBe(false);
	});

	it("zeigt ihn bei einer frischen Erstinstallation nicht - dort laeuft das Onboarding", () => {
		expect(startup(true)).toBe(false);
		expect(localStorage.getItem(KEY)).toBe(CURRENT_RELEASE.version);
	});

	it("bleibt im Browser ganz aus", () => {
		isTauri.mockReturnValue(false);
		localStorage.setItem(KEY, "0.8.0");
		expect(startup()).toBe(false);
	});
});

describe("markAsSeen", () => {
	it("schliesst den Dialog und merkt sich die Fassung", () => {
		whatsNew.open();
		whatsNew.markAsSeen();
		expect(whatsNew.isOpen).toBe(false);
		expect(localStorage.getItem(KEY)).toBe(CURRENT_RELEASE.version);
	});
});
