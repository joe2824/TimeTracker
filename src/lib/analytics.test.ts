import { describe, expect, it } from "vitest";
import { classifyPingFailure, detectPlatform } from "./analytics";

describe("detectPlatform", () => {
	it("nennt ohne Fenster keine Plattform", () => {
		expect(detectPlatform()).toBe("unknown");
	});
});

describe("classifyPingFailure", () => {
	// Ein Server ohne TELEMETRY_KEY antwortet dauerhaft mit 404. Als "spaeter
	// nochmal" gelesen klopfte die Anwendung endlos an.
	it("gibt auf, wo ein zweiter Versuch nichts anderes ergaebe", () => {
		for (const status of [403, 404, 405, 410]) {
			expect(classifyPingFailure(status)).toBe("declined");
		}
	});

	// 401 heisst auch "gerade abgemeldet". Wer sich wieder anmeldet, soll wieder
	// zaehlen - gegen endloses Klopfen steht die Versuchsgrenze im Waechter.
	it("wiederholt, wo es sich noch aendern kann", () => {
		for (const status of [0, 401, 429, 500, 502]) {
			expect(classifyPingFailure(status)).toBe("retry");
		}
	});
});
