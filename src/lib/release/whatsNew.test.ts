// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { files, resetFakeFs } from "../testing/fakeFs";

vi.mock("@tauri-apps/plugin-fs", async () => (await import("../testing/fakeFs")).fakeFs);

const isTauri = vi.fn(() => true);
vi.mock("../platform/env", () => ({ isTauri: () => isTauri() }));

const { CURRENT_RELEASE, whatsNew } = await import("./whatsNew.svelte");

const KEY = "timetracker:last_seen_release";
const FILE = "data/release-seen.json";

beforeEach(() => {
	vi.useFakeTimers();
	localStorage.clear();
	resetFakeFs();
	isTauri.mockReturnValue(true);
	whatsNew.isOpen = false;
});

afterEach(() => vi.useRealTimers());

/** Startlauf durchspielen und zurückgeben, ob der Dialog aufgegangen ist. */
async function startup(isFirstAppStart = false): Promise<boolean> {
	await whatsNew.checkOnStartup(isFirstAppStart);
	vi.advanceTimersByTime(1000);
	return whatsNew.isOpen;
}

function seenInFile(): string | undefined {
	const txt = files.get(FILE);
	return txt === undefined ? undefined : (JSON.parse(txt) as { version: string }).version;
}

function seedFile(version: string): void {
	files.set(FILE, JSON.stringify({ version }));
}

describe("checkOnStartup", () => {
	it("zeigt den Dialog, wenn diese Release-Fassung noch nicht gesehen wurde", async () => {
		seedFile("0.8.0");
		expect(await startup()).toBe(true);
	});

	it("zeigt ihn Nutzern, die zuletzt den Inhalt von 0.9.0 gesehen haben", async () => {
		seedFile("0.9.0");
		expect(await startup()).toBe(true);
	});

	it("zeigt ihn nicht noch einmal, wenn dieselbe Fassung schon gesehen wurde", async () => {
		seedFile(CURRENT_RELEASE.version);
		expect(await startup()).toBe(false);
	});

	it("zeigt ihn nach einem Bugfix-Release nicht erneut", async () => {
		// Der Kern der Sache: CURRENT_RELEASE.version gehört zum INHALT, nicht zur
		// App-Version. Wird sie bei einem Release ohne neuen Text mitgezogen,
		// bekommt jeder denselben Dialog ein zweites Mal.
		seedFile("1.1.0");
		expect(CURRENT_RELEASE.version).toBe("1.1.0");
		expect(await startup()).toBe(false);
	});

	it("zeigt ihn nicht, wenn schon eine SPAETERE Fassung gesehen wurde", async () => {
		// Wer 1.1.1 bereits weggeklickt hat, kennt diesen Inhalt. Ein Vergleich
		// auf Ungleichheit zeigte ihn erneut.
		seedFile("1.1.1");
		expect(await startup()).toBe(false);
	});

	it("zeigt ihn auch nach einer Vorabfassung derselben Nummer nicht", async () => {
		seedFile("1.1.0-beta.3");
		expect(await startup()).toBe(false);
	});

	it("zeigt ihn bei einer frischen Erstinstallation nicht - dort laeuft das Onboarding", async () => {
		expect(await startup(true)).toBe(false);
		expect(seenInFile()).toBe(CURRENT_RELEASE.version);
	});

	it("bleibt im Browser ganz aus", async () => {
		isTauri.mockReturnValue(false);
		seedFile("0.8.0");
		expect(await startup()).toBe(false);
	});

	it("zeigt ihn nicht erneut, wenn der Speicher der Webansicht den Vermerk wieder verliert", async () => {
		// WebView2 kann nach einem harten Prozessende bei jedem Start auf einen
		// alten Stand seines localStorage zurückfallen - der Vermerk darf daran
		// nicht hängen.
		localStorage.setItem(KEY, "0.9.1");
		expect(await startup()).toBe(true);
		await whatsNew.markAsSeen();
		localStorage.setItem(KEY, "0.9.1");
		expect(await startup()).toBe(false);
	});

	it("übernimmt den Vermerk von Bestandsgeräten aus dem Speicher der Webansicht", async () => {
		localStorage.setItem(KEY, CURRENT_RELEASE.version);
		expect(await startup()).toBe(false);
		expect(seenInFile()).toBe(CURRENT_RELEASE.version);
	});

	it("zeigt ihn Bestandsgeräten, deren Vermerk älter ist", async () => {
		localStorage.setItem(KEY, "0.9.0");
		expect(await startup()).toBe(true);
	});
});

describe("markAsSeen", () => {
	it("schliesst den Dialog und merkt sich die Fassung", async () => {
		whatsNew.open();
		await whatsNew.markAsSeen();
		expect(whatsNew.isOpen).toBe(false);
		expect(seenInFile()).toBe(CURRENT_RELEASE.version);
	});
});
