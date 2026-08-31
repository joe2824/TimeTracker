// Die Bremse - als Rechnung, ohne Server.
import { beforeEach, describe, expect, it } from "vitest";
import { isLocked, takeAttempt, cleanupLimits, resetLimitsForTests } from "./limit";

const RATE = { burst: 5, perMinute: 60 };

beforeEach(() => resetLimitsForTests());

describe("Token-Eimer", () => {
	it("laesst den Vorrat durch und bremst danach", () => {
		for (let i = 0; i < 5; i++) {
			expect(takeAttempt("a", RATE, 1000).allowed).toBe(true);
		}
		expect(takeAttempt("a", RATE, 1000).allowed).toBe(false);
	});

	it("sagt, wie lange zu warten ist", () => {
		for (let i = 0; i < 5; i++) takeAttempt("a", RATE, 1000);
		const { retryAfter } = takeAttempt("a", RATE, 1000);
		// 60 je Minute heisst: eine Sekunde bis zum naechsten.
		expect(retryAfter).toBe(1);
	});

	it("fuellt mit der Zeit wieder auf", () => {
		for (let i = 0; i < 5; i++) takeAttempt("a", RATE, 1000);
		expect(takeAttempt("a", RATE, 1000).allowed).toBe(false);
		// Zwei Sekunden spaeter sind zwei Versuche nachgeflossen.
		expect(takeAttempt("a", RATE, 3000).allowed).toBe(true);
		expect(takeAttempt("a", RATE, 3000).allowed).toBe(true);
		expect(takeAttempt("a", RATE, 3000).allowed).toBe(false);
	});

	it("fuellt nie ueber den Rand", () => {
		takeAttempt("a", RATE, 1000);
		// Eine Stunde Ruhe - der Eimer ist voll, nicht uebervoll.
		for (let i = 0; i < 5; i++) {
			expect(takeAttempt("a", RATE, 3_601_000).allowed).toBe(true);
		}
		expect(takeAttempt("a", RATE, 3_601_000).allowed).toBe(false);
	});

	it("haelt die Schluessel auseinander", () => {
		for (let i = 0; i < 5; i++) takeAttempt("a", RATE, 1000);
		expect(takeAttempt("a", RATE, 1000).allowed).toBe(false);
		// Ein anderer Aufrufer ist davon unberuehrt - sonst waere die Bremse
		// selbst der Angriff: einer sperrt alle aus.
		expect(takeAttempt("b", RATE, 1000).allowed).toBe(true);
	});

	it("wirft nur volle Eimer weg", () => {
		takeAttempt("frisch", RATE, 3_600_000);
		for (let i = 0; i < 5; i++) takeAttempt("erschoepft", RATE, 3_600_000);
		// Direkt danach aufraeumen: beide sind zu jung, beide bleiben.
		cleanupLimits(3_600_001);
		expect(takeAttempt("erschoepft", RATE, 3_600_001).allowed).toBe(false);
	});
});

describe("Nachsehen ohne zu verbrauchen", () => {
	it("meldet nicht gesperrt, solange noch etwas drin ist", () => {
		takeAttempt("x", RATE, 1000);
		expect(isLocked("x", RATE, 1000)).toBe(false);
	});

	it("verbraucht selbst nichts", () => {
		// Der Punkt: wer wartet, fragt oft nach. Duerfte das Nachsehen selbst
		// zaehlen, waere die Bremse genau fuer den gedacht, den sie nicht treffen
		// soll.
		for (let i = 0; i < 100; i++) isLocked("y", RATE, 1000);
		for (let i = 0; i < 5; i++) expect(takeAttempt("y", RATE, 1000).allowed).toBe(true);
	});

	it("meldet gesperrt, wenn der Eimer leer ist", () => {
		for (let i = 0; i < 5; i++) takeAttempt("z", RATE, 1000);
		expect(isLocked("z", RATE, 1000)).toBe(true);
		// Und gibt wieder frei, sobald nachgeflossen ist.
		expect(isLocked("z", RATE, 2000)).toBe(false);
	});
});
