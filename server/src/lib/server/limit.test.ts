// Die Bremse - als Rechnung, ohne Server.
import { beforeEach, describe, expect, it } from "vitest";
import { nimmVersuch, raeumeLimits, resetLimitsForTests } from "./limit";

const SATZ = { burst: 5, perMinute: 60 };

beforeEach(() => resetLimitsForTests());

describe("Token-Eimer", () => {
	it("laesst den Vorrat durch und bremst danach", () => {
		for (let i = 0; i < 5; i++) {
			expect(nimmVersuch("a", SATZ, 1000).erlaubt).toBe(true);
		}
		expect(nimmVersuch("a", SATZ, 1000).erlaubt).toBe(false);
	});

	it("sagt, wie lange zu warten ist", () => {
		for (let i = 0; i < 5; i++) nimmVersuch("a", SATZ, 1000);
		const { retryAfter } = nimmVersuch("a", SATZ, 1000);
		// 60 je Minute heisst: eine Sekunde bis zum naechsten.
		expect(retryAfter).toBe(1);
	});

	it("fuellt mit der Zeit wieder auf", () => {
		for (let i = 0; i < 5; i++) nimmVersuch("a", SATZ, 1000);
		expect(nimmVersuch("a", SATZ, 1000).erlaubt).toBe(false);
		// Zwei Sekunden spaeter sind zwei Versuche nachgeflossen.
		expect(nimmVersuch("a", SATZ, 3000).erlaubt).toBe(true);
		expect(nimmVersuch("a", SATZ, 3000).erlaubt).toBe(true);
		expect(nimmVersuch("a", SATZ, 3000).erlaubt).toBe(false);
	});

	it("fuellt nie ueber den Rand", () => {
		nimmVersuch("a", SATZ, 1000);
		// Eine Stunde Ruhe - der Eimer ist voll, nicht uebervoll.
		for (let i = 0; i < 5; i++) {
			expect(nimmVersuch("a", SATZ, 3_601_000).erlaubt).toBe(true);
		}
		expect(nimmVersuch("a", SATZ, 3_601_000).erlaubt).toBe(false);
	});

	it("haelt die Schluessel auseinander", () => {
		for (let i = 0; i < 5; i++) nimmVersuch("a", SATZ, 1000);
		expect(nimmVersuch("a", SATZ, 1000).erlaubt).toBe(false);
		// Ein anderer Aufrufer ist davon unberuehrt - sonst waere die Bremse
		// selbst der Angriff: einer sperrt alle aus.
		expect(nimmVersuch("b", SATZ, 1000).erlaubt).toBe(true);
	});

	it("wirft nur volle Eimer weg", () => {
		nimmVersuch("frisch", SATZ, 3_600_000);
		for (let i = 0; i < 5; i++) nimmVersuch("erschoepft", SATZ, 3_600_000);
		// Direkt danach aufraeumen: beide sind zu jung, beide bleiben.
		raeumeLimits(3_600_001);
		expect(nimmVersuch("erschoepft", SATZ, 3_600_001).erlaubt).toBe(false);
	});
});
