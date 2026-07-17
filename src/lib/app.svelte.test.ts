import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Activity, Entry } from "./types";
import { files, resetFakeFs } from "./testing/fakeFs";

vi.mock("@tauri-apps/plugin-fs", async () => (await import("./testing/fakeFs")).fakeFs);
// Toasts sind hier Beiwerk; die Meldungen selbst prueft niemand.
vi.mock("svelte-sonner", () => ({
	toast: Object.assign(() => {}, { info() {}, error() {}, success() {}, warning() {} })
}));

const { app } = await import("./app.svelte");

const P1 = "p1";
const P2 = "p2";
const ABS = "abs";
const ACTIVITIES: Activity[] = [
	{ id: P1, name: "Projekt 1", sortOrder: 0, archived: false, isAbsence: false },
	{ id: P2, name: "Projekt 2", sortOrder: 1, archived: false, isAbsence: false },
	{ id: ABS, name: "Abwesenheiten", sortOrder: 2, archived: false, isAbsence: true }
];

const at = (day: number, h: number, min = 0) => new Date(2026, 6, day, h, min, 0, 0).getTime();
const monthFile = (m: string) => `data/entries-${m}.json`;
const onDisk = (m: string): Entry[] => JSON.parse(files.get(monthFile(m)) ?? "[]");

/** Frischer App-Zustand ohne init() – das wuerde den Sekunden-Tick starten. */
function reset(entries: Record<string, Entry[]> = {}) {
	resetFakeFs();
	app.dispose();
	app.activities = [...ACTIVITIES];
	app.running = null;
	app.entriesByMonth = {};
	app.backdatePrompt = null;
	for (const [m, list] of Object.entries(entries)) {
		app.entriesByMonth[m] = list;
		files.set(monthFile(m), JSON.stringify(list));
	}
}

const entry = (id: string, activityId: string, startTs: number, endTs: number | null): Entry => ({
	id,
	activityId,
	startTs,
	endTs,
	note: "",
	source: "timer"
});

beforeEach(() => reset());

describe("stop() – Teilung an Mitternacht", () => {
	it("teilt einen Timer über Mitternacht und schreibt beide Tage", async () => {
		const laufend = entry("r", P1, at(16, 23, 25), null);
		reset({ "2026-07": [laufend] });
		app.running = laufend;

		await app.stop(at(17, 1, 1));

		const es = onDisk("2026-07").sort((a, b) => a.startTs - b.startTs);
		expect(es).toHaveLength(2);
		expect(es[0].endTs).toBe(at(17, 0)); // endet an Mitternacht
		expect(es[1].startTs).toBe(at(17, 0)); // beginnt am neuen Tag
		expect(es[1].endTs).toBe(at(17, 1, 1));
		expect(app.running).toBeNull();
	});

	it("legt das Folgetag-Stück in die richtige MONATSDATEI", async () => {
		// Ueber die Monatsgrenze: sonst zaehlte die Zeit im falschen Bericht.
		const silvester = new Date(2026, 6, 31, 23, 0, 0).getTime();
		const laufend = entry("r", P1, silvester, null);
		reset({ "2026-07": [laufend] });
		app.running = laufend;

		await app.stop(new Date(2026, 7, 1, 1, 0, 0).getTime());

		expect(onDisk("2026-07")).toHaveLength(1);
		expect(onDisk("2026-08")).toHaveLength(1);
		expect(onDisk("2026-08")[0].startTs).toBe(new Date(2026, 7, 1, 0, 0, 0).getTime());
	});

	it("lässt einen Timer innerhalb eines Tages ungeteilt", async () => {
		const laufend = entry("r", P1, at(17, 8), null);
		reset({ "2026-07": [laufend] });
		app.running = laufend;

		await app.stop(at(17, 12));

		expect(onDisk("2026-07")).toHaveLength(1);
		expect(onDisk("2026-07")[0].endTs).toBe(at(17, 12));
	});
});

describe("addEntry – Konfliktregeln", () => {
	it("lehnt eine Überschneidung ab", async () => {
		reset({ "2026-07": [entry("a", P1, at(17, 8), at(17, 12))] });
		expect(await app.addEntry(P2, at(17, 10), at(17, 14))).toBeNull();
		expect(onDisk("2026-07")).toHaveLength(1);
	});

	it("lässt aneinander anstoßende Zeiten zu", async () => {
		reset({ "2026-07": [entry("a", P1, at(17, 8), at(17, 12))] });
		expect(await app.addEntry(P2, at(17, 12), at(17, 14))).not.toBeNull();
		expect(onDisk("2026-07")).toHaveLength(2);
	});

	it("lehnt Projektzeit an einem Ganztags-Abwesenheitstag ab", async () => {
		const urlaub: Entry = { ...entry("v", ABS, at(17, 12), at(17, 12)), dayFraction: 1 };
		reset({ "2026-07": [urlaub] });
		expect(await app.addEntry(P1, at(17, 8), at(17, 12))).toBeNull();
	});
});

describe("deleteYearEntries", () => {
	it("löscht nur das genannte Jahr – aus Datei UND Cache", async () => {
		reset({
			"2025-12": [entry("alt", P1, new Date(2025, 11, 1, 8).getTime(), new Date(2025, 11, 1, 9).getTime())],
			"2026-07": [entry("neu", P1, at(17, 8), at(17, 9))]
		});

		expect(await app.deleteYearEntries(2025)).toBe(1);

		expect(files.has(monthFile("2025-12"))).toBe(false);
		expect(app.entriesByMonth["2025-12"]).toBeUndefined(); // Cache mit geraeumt
		expect(onDisk("2026-07")).toHaveLength(1);
	});

	it("stoppt einen Timer, der im gelöschten Jahr läuft", async () => {
		const laufend = entry("r", P1, new Date(2025, 11, 1, 8).getTime(), null);
		reset({ "2025-12": [laufend] });
		app.running = laufend;

		await app.deleteYearEntries(2025);

		expect(app.running).toBeNull();
	});

	it("meldet die Änderung, damit abgeleitete Listen neu lesen", async () => {
		reset({ "2025-12": [entry("alt", P1, new Date(2025, 11, 1, 8).getTime(), new Date(2025, 11, 1, 9).getTime())] });
		const vorher = app.entriesVersion;
		await app.deleteYearEntries(2025);
		expect(app.entriesVersion).toBeGreaterThan(vorher);
	});
});

describe("Zurückgebliebene offene Einträge (Absturz)", () => {
	/** Zustand von Platte lesen – der Weg, auf dem #findRunning läuft. */
	async function reloadAt(now: number, entries: Entry[]) {
		reset({ "2026-07": entries });
		app.entriesByMonth = {};
		files.set("data/activities.json", JSON.stringify(ACTIVITIES));
		app.now = now; // reload() liest currentMonth hieraus, bevor es now neu setzt
		await app.reload();
	}

	it("schließt einen zurückgebliebenen Eintrag am nächsten Start – statt ihn zu nullen", async () => {
		// Der Klassiker: Absturz um 12, danach neu gestartet. Der 09–12-Block ist
		// echte Arbeit und bekam frueher endTs = startTs, also Dauer 0.
		await reloadAt(at(17, 15), [entry("alt", P1, at(17, 9), null), entry("neu", P2, at(17, 12), null)]);

		const alt = onDisk("2026-07").find((e) => e.id === "alt")!;
		expect(alt.endTs).toBe(at(17, 12)); // nicht at(17, 9)
		expect(app.running?.id).toBe("neu"); // der neueste läuft weiter
	});

	it("kappt am eigenen Tagesende, statt ein Wochenende zu schlucken", async () => {
		// Absturz am Freitag, App erst Montag wieder auf. Ohne Kappung stuenden
		// hier 72 Stunden.
		await reloadAt(at(20, 10), [entry("fr", P1, at(17, 9), null), entry("mo", P2, at(20, 8), null)]);

		const fr = onDisk("2026-07").find((e) => e.id === "fr")!;
		expect(fr.endTs).toBe(at(18, 0)); // Mitternacht des eigenen Tages
	});

	it("lässt einen echten Doppelstart bei Dauer 0", async () => {
		// Gleicher Zeitstempel = versehentlich zweimal gestartet, keine Arbeitszeit.
		await reloadAt(at(17, 15), [entry("a", P1, at(17, 9), null), entry("b", P2, at(17, 9), null)]);

		const geschlossen = onDisk("2026-07").filter((e) => e.endTs !== null);
		expect(geschlossen).toHaveLength(1);
		expect(geschlossen[0].endTs).toBe(geschlossen[0].startTs);
	});

	it("rührt einen einzelnen laufenden Eintrag nicht an", async () => {
		await reloadAt(at(17, 15), [entry("r", P1, at(17, 9), null)]);

		expect(app.running?.id).toBe("r");
		expect(onDisk("2026-07")[0].endTs).toBeNull();
	});
});

describe("Teilung respektiert Ganztags-Abwesenheiten", () => {
	it("legt kein Folgetag-Stück an, wenn der neue Tag ganztags abwesend ist", async () => {
		// Sonst umginge die Mitternachts-Teilung die Regel, die #reportConflict
		// ueberall sonst durchsetzt: Urlaubstag traegt keine Projektzeit.
		const urlaub: Entry = { ...entry("v", ABS, at(17, 12), at(17, 12)), dayFraction: 1 };
		const laufend = entry("r", P1, at(16, 22), null);
		reset({ "2026-07": [urlaub, laufend] });
		app.running = laufend;

		await app.stop(at(17, 3));

		const projekt = onDisk("2026-07").filter((e) => e.activityId === P1);
		expect(projekt).toHaveLength(1);
		expect(projekt[0].endTs).toBe(at(17, 0)); // endet an Mitternacht, kein Stueck danach
	});
});
