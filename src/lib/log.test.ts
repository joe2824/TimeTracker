import { beforeEach, describe, expect, it, vi } from "vitest";
import { files, fsFaults, resetFakeFs } from "./testing/fakeFs";
import { wallToTs } from "./time/tz";

vi.mock("@tauri-apps/plugin-fs", async () => (await import("./testing/fakeFs")).fakeFs);

const { clearLogs, errorText, flushLog, listLogs, logError, logFile, logInfo, pruneOldLogs, readLog } =
	await import("./log");

const today = () => files.get(logFile()) ?? "";
/** Ein Durchlauf der Ereignisschlange – ohne den Puffer selbst zu leeren. */
const tick = () => new Promise((r) => setTimeout(r, 0));

beforeEach(async () => {
	resetFakeFs();
	await flushLog(); // Reste aus dem vorigen Test nicht in den naechsten tragen
	files.clear();
});

describe("Protokollieren", () => {
	it("schreibt Zeitstempel, Stufe und Meldung in die Tagesdatei", async () => {
		logInfo("Timer gestartet", { activityId: "p1" });
		await flushLog();

		const line = today().trim();
		expect(line).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3} /);
		expect(line).toContain("INFO");
		expect(line).toContain("Timer gestartet");
		expect(line).toContain('{"activityId":"p1"}');
	});

	it("haengt an, statt die Datei zu ueberschreiben", async () => {
		logInfo("erste");
		logInfo("zweite");
		await flushLog();
		logInfo("dritte");
		await flushLog();

		const lines = today().trim().split("\n");
		expect(lines).toHaveLength(3);
		expect(lines[0]).toContain("erste");
		expect(lines[2]).toContain("dritte");
	});

	it("schreibt Fehler sofort – ohne sie im Puffer zu sammeln", async () => {
		// Die letzte Zeile vor einem Absturz ist die interessanteste; ein gepufferter
		// Fehler waere genau die, die fehlt.
		logError("Start fehlgeschlagen", new Error("fs.scope forbidden path"));
		await tick();

		expect(today()).toContain("ERROR");
		expect(today()).toContain("fs.scope forbidden path");
	});

	it("sammelt gewoehnliche Meldungen, statt fuer jede Zeile zu schreiben", async () => {
		logInfo("nur gepuffert");
		await tick();
		expect(today()).toBe("");

		await flushLog();
		expect(today()).toContain("nur gepuffert");
	});

	it("nimmt die Aufrufliste eines Fehlers mit – eingerueckt als Fortsetzung", async () => {
		logError("kaputt", new Error("Ursache"));
		await flushLog();

		const lines = today().split("\n");
		expect(lines[0]).toContain("Error: Ursache");
		// Fortsetzungszeilen beginnen mit Tab: sonst saehen sie wie eigene Eintraege
		// aus und der Filter in der Protokoll-Karte liesse sie liegen.
		expect(lines[1]).toMatch(/^\t\s*at /);
		expect(today()).toContain("log.test.ts");
	});

	it("bleibt still, wenn das Dateisystem nicht mitspielt", async () => {
		// Protokollieren darf die App nie kippen – auch dann nicht, wenn genau das
		// Dateisystem klemmt, ueber das sich der Fehler melden liesse.
		fsFaults.existsThrows = true;
		logError("egal");
		await expect(flushLog()).resolves.toBeUndefined();
	});
});

describe("readLog", () => {
	it("liefert die letzten Zeilen, aelteste zuerst", async () => {
		for (let i = 1; i <= 5; i++) logInfo(`Zeile ${i}`);
		await flushLog();

		const lines = await readLog(3);
		expect(lines).toHaveLength(3);
		expect(lines[0]).toContain("Zeile 3");
		expect(lines[2]).toContain("Zeile 5");
	});

	it("nimmt den Vortag dazu, wenn heute erst wenig steht", async () => {
		// Kurz nach Mitternacht ist die heutige Datei fast leer und das Gesuchte
		// von gestern.
		files.set(logFile(Date.now() - 24 * 60 * 60 * 1000), "gestern A\ngestern B\n");
		logInfo("heute");
		await flushLog();

		const lines = await readLog();
		expect(lines[0]).toBe("gestern A");
		expect(lines.at(-1)).toContain("heute");
	});

	it("ist leer, solange nichts protokolliert wurde", async () => {
		expect(await readLog()).toEqual([]);
	});
});

describe("pruneOldLogs", () => {
	it("loescht alte Tage und behaelt die jungen", async () => {
		const now = wallToTs(2026, 7, 28, 12, 0, 0);
		files.set("logs/2026-07-01.log", "alt");
		files.set("logs/2026-07-13.log", "genau zu alt");
		files.set("logs/2026-07-20.log", "gerade noch");
		files.set("logs/2026-07-28.log", "heute");

		const removed = await pruneOldLogs(14, now);

		expect(removed).toEqual(["2026-07-13.log", "2026-07-01.log"]);
		expect(await listLogs()).toEqual(["2026-07-28.log", "2026-07-20.log"]);
	});

	it("laesst fremde Dateien im Ordner in Ruhe", async () => {
		files.set("logs/notizen.txt", "kein Protokoll");
		files.set("data/entries-2020-01.json", "[]");

		await pruneOldLogs(1, wallToTs(2026, 7, 28, 0, 0, 0));

		expect(files.has("logs/notizen.txt")).toBe(true);
		expect(files.has("data/entries-2020-01.json")).toBe(true);
	});
});

describe("clearLogs", () => {
	it("raeumt alle Tagesdateien weg", async () => {
		files.set("logs/2026-07-01.log", "alt");
		logInfo("heute");
		await flushLog();

		expect(await clearLogs()).toBe(2);
		expect(await listLogs()).toEqual([]);
	});
});

describe("errorText", () => {
	it("nennt die Ursache statt nur der Fehlerklasse", () => {
		expect(errorText(new Error("kaputt"))).toBe("kaputt");
		expect(errorText("fs.scope forbidden path")).toBe("fs.scope forbidden path");
		expect(errorText({ code: 5 })).toBe('{"code":5}');
	});
});
