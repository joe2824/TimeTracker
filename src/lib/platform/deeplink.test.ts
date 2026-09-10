// Was aus einem "timetracker://"-Link herausfällt.
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	pairCodeFrom,
	pairLink,
	pairStartFrom,
	pairStartLink,
	alreadyHandled,
	teamJoinFrom,
	teamJoinLink
} from "./deeplink";

describe("pairCodeAus", () => {
	it("liest den Code", () => {
		expect(pairCodeFrom("timetracker://pair/ABCDEFGHJKLM")).toBe("ABCDEFGHJKLM");
	});

	it("vertraegt einen Schraegstrich am Ende", () => {
		// Je nach Betriebssystem kommt der Link mit oder ohne an.
		expect(pairCodeFrom("timetracker://pair/ABCD/")).toBe("ABCD");
	});

	it("ignoriert Anhaengsel", () => {
		expect(pairCodeFrom("timetracker://pair/ABCD?x=1")).toBe("ABCD");
		expect(pairCodeFrom("timetracker://pair/ABCD#top")).toBe("ABCD");
	});

	it("nimmt Leerzeichen drumherum", () => {
		expect(pairCodeFrom("  timetracker://pair/ABCD  ")).toBe("ABCD");
	});

	it("gibt null bei allem anderen", () => {
		expect(pairCodeFrom("https://example.de/pair/ABCD")).toBeNull();
		expect(pairCodeFrom("timetracker://sonstwas/ABCD")).toBeNull();
		expect(pairCodeFrom("timetracker://pair/")).toBeNull();
		expect(pairCodeFrom("")).toBeNull();
	});

	it("passt zu pairLink", () => {
		expect(pairCodeFrom(pairLink("ABCDEFGHJKLM"))).toBe("ABCDEFGHJKLM");
	});
});

describe("pairStartFrom", () => {
	it("liest die Serveradresse", () => {
		expect(pairStartFrom("timetracker://pair?server=https%3A%2F%2Ftt.example.de")).toBe(
			"https://tt.example.de"
		);
	});

	it("vertraegt einen Schraegstrich vor dem Fragezeichen", () => {
		expect(pairStartFrom("timetracker://pair/?server=https%3A%2F%2Ftt.example.de")).toBe(
			"https://tt.example.de"
		);
	});

	it("verwechselt sich nicht mit einem Code-Link", () => {
		expect(pairStartFrom("timetracker://pair/ABCD-EFGH-JKLM")).toBeNull();
		expect(pairCodeFrom("timetracker://pair?server=https%3A%2F%2Ftt.example.de")).toBeNull();
	});

	it("passt zu pairStartLink", () => {
		const url = "https://tt.example.de";
		expect(pairStartFrom(pairStartLink(url))).toBe(url);
	});

	it("gibt null ohne Adresse", () => {
		expect(pairStartFrom("timetracker://pair?server=")).toBeNull();
		expect(pairStartFrom("timetracker://andere")).toBeNull();
	});
});

describe("teamJoinFrom", () => {
	const url = "https://tt.example.de";
	const suffix = `?server=${encodeURIComponent(url)}`;

	it("liest Beitrittscode und Serveradresse", () => {
		expect(teamJoinFrom(`timetracker://team/join/ABCD-EFGH-JKLM-NPQR${suffix}`)).toEqual({
			code: "ABCD-EFGH-JKLM-NPQR",
			serverUrl: url
		});
	});

	it("vertraegt einen Schraegstrich vor dem Fragezeichen", () => {
		expect(teamJoinFrom(`timetracker://team/join/ABCD/${suffix}`)).toEqual({ code: "ABCD", serverUrl: url });
	});

	it("verwechselt sich nicht mit einem Kopplungslink", () => {
		expect(teamJoinFrom(`timetracker://pair/ABCD${suffix}`)).toBeNull();
		expect(pairCodeFrom(`timetracker://team/join/ABCD${suffix}`)).toBeNull();
	});

	it("gibt null ohne Serveradresse", () => {
		expect(teamJoinFrom("timetracker://team/join/ABCD")).toBeNull();
	});

	it("gibt null bei allem anderen", () => {
		expect(teamJoinFrom(`https://example.de/team/join/ABCD${suffix}`)).toBeNull();
		expect(teamJoinFrom(`timetracker://team/join/${suffix}`)).toBeNull();
		expect(teamJoinFrom("")).toBeNull();
	});

	it("passt zu teamJoinLink", () => {
		expect(teamJoinFrom(teamJoinLink(url, "ABCD-EFGH-JKLM-NPQR"))).toEqual({
			code: "ABCD-EFGH-JKLM-NPQR",
			serverUrl: url
		});
	});
});

describe("onPairLink: dieselbe Adresse nur einmal", () => {
	// Die Tests laufen unter `environment: "node"` - dort gibt es kein
	// sessionStorage. Ein Minimalersatz genuegt: mehr braucht die Regel nicht.
	beforeEach(() => {
		const store = new Map<string, string>();
		vi.stubGlobal("sessionStorage", {
			getItem: (k: string) => store.get(k) ?? null,
			setItem: (k: string, v: string) => void store.set(k, v),
			clear: () => store.clear()
		});
	});

	it("meldet einen Start-Link nur beim ersten Mal", async () => {
		const url = "timetracker://pair?server=https%3A%2F%2Ftt.example.de";
		const seen: string[] = [];
		// `getCurrent` liefert die Start-Adresse nach jedem Neuladen erneut - der
		// zweite Aufruf steht hier fuer genau das.
		for (let i = 0; i < 2; i++) {
			const code = pairCodeFrom(url);
			if (!code && !alreadyHandled(url)) seen.push(pairStartFrom(url) ?? "");
		}
		expect(seen).toEqual(["https://tt.example.de"]);
	});

	it("laesst eine ANDERE Adresse durch", () => {
		const a = "timetracker://pair?server=https%3A%2F%2Fa.example.de";
		const b = "timetracker://pair?server=https%3A%2F%2Fb.example.de";
		expect(alreadyHandled(a)).toBe(false);
		expect(alreadyHandled(b)).toBe(false);
		expect(alreadyHandled(a)).toBe(true);
	});

	it("ein Praefix haelt zwei Hoerer auf derselben Adresse auseinander", () => {
		// onPairLink und onTeamJoinLink horchen unabhaengig auf JEDE Adresse und
		// pruefen `alreadyHandled` VOR dem eigentlichen Erkennen - ohne eigenen
		// Praefix markierte der eine eine Adresse als erledigt, die er selbst gar
		// nicht erkannte, und der andere saehe sie danach nie (der eigentliche
		// Fehler, den dieser Test verhindert).
		const url = "timetracker://team/join/ABCD?server=https%3A%2F%2Ftt.example.de";
		expect(alreadyHandled(`pair:${url}`)).toBe(false);
		expect(alreadyHandled(`team:${url}`)).toBe(false);
		// Und innerhalb je eines Praefix gilt weiterhin: nur beim ersten Mal.
		expect(alreadyHandled(`pair:${url}`)).toBe(true);
		expect(alreadyHandled(`team:${url}`)).toBe(true);
	});
});
