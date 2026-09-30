import { afterEach, describe, expect, it, vi } from "vitest";
import { classifyPingFailure, detectPlatform } from "./analytics";

describe("detectPlatform", () => {
	afterEach(() => vi.unstubAllGlobals());

	function browser(userAgent: string, platform: string, tauri = false) {
		vi.stubGlobal("window", tauri ? { __TAURI_INTERNALS__: {} } : {});
		vi.stubGlobal("navigator", { userAgent, platform });
	}

	it("nennt ohne Fenster keine Plattform", () => {
		expect(detectPlatform()).toBe("unknown");
	});

	// Das iPhone meldet "like Mac OS X" und landete als "web-mac" in der Statistik.
	it("zählt ein iPhone nicht als Mac", () => {
		browser(
			"Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15",
			"iPhone"
		);
		expect(detectPlatform()).toBe("web");
	});

	// Android meldet "Linux" und landete als "web-linux".
	it("zählt Android nicht als Linux", () => {
		browser("Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36", "Linux armv8l");
		expect(detectPlatform()).toBe("web");
	});

	it.each([
		["Mozilla/5.0 (Windows NT 10.0; Win64; x64)", "Win32", "web-win"],
		["Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)", "MacIntel", "web-mac"],
		["Mozilla/5.0 (X11; Linux x86_64)", "Linux x86_64", "web-linux"],
		["Mozilla/5.0", "", "web"]
	])("erkennt den Browser auf %s", (ua, platform, expected) => {
		browser(ua, platform);
		expect(detectPlatform()).toBe(expected);
	});

	it.each([
		["Mozilla/5.0 (Windows NT 10.0; Win64; x64)", "Win32", "windows"],
		["Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)", "MacIntel", "macos"],
		["Mozilla/5.0 (X11; Linux x86_64)", "Linux x86_64", "linux"],
		["Mozilla/5.0", "", "desktop"]
	])("erkennt die Desktop-Anwendung auf %s", (ua, platform, expected) => {
		browser(ua, platform, true);
		expect(detectPlatform()).toBe(expected);
	});
});

describe("classifyPingFailure", () => {
	// Ein Server ohne TELEMETRY_KEY antwortet dauerhaft mit 404. Als "später
	// nochmal" gelesen klopfte die Anwendung endlos an.
	it("gibt auf, wo ein zweiter Versuch nichts anderes ergaebe", () => {
		for (const status of [403, 404, 405, 410]) {
			expect(classifyPingFailure(status)).toBe("declined");
		}
	});

	// 401 heisst auch "gerade abgemeldet". Wer sich wieder anmeldet, soll wieder
	// zählen - gegen endloses Klopfen steht die Versuchsgrenze im Wächter.
	it("wiederholt, wo es sich noch aendern kann", () => {
		for (const status of [0, 401, 429, 500, 502]) {
			expect(classifyPingFailure(status)).toBe("retry");
		}
	});
});
