import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Activity, Entry } from "./types";
import { files, fsFaults, resetFakeFs } from "./testing/fakeFs";

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
	app.absenceOverridePrompt = null;
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

describe("stop() – Lauf über mehrere Tage nachträglich beenden", () => {
	/**
	 * Der Fall aus der Praxis: Timer am 16. um 09:00 gestartet, Rechner drei Tage
	 * zugeklappt. Der Mitternachts-Wechsel hat daraus vier Stuecke gemacht (zwei
	 * davon volle 24-Stunden-Tage). Wer im "Timer läuft noch"-Dialog das echte
	 * Ende einträgt, meint den ganzen Lauf – nicht nur das letzte Stueck.
	 */
	function laufUeberDreiTage() {
		const stuecke = [
			entry("t1", P1, at(16, 9), at(17, 0)),
			entry("t2", P1, at(17, 0), at(18, 0)),
			entry("t3", P1, at(18, 0), at(19, 0)),
			entry("t4", P1, at(19, 0), null)
		];
		reset({ "2026-07": stuecke });
		app.running = stuecke[3];
		return stuecke;
	}

	it("räumt die Tagesstücke weg, die nach der eingetragenen Endzeit liegen", async () => {
		laufUeberDreiTage();

		await app.stop(at(16, 17)); // "aufgehört habe ich am 16. um 17 Uhr"

		const es = onDisk("2026-07");
		expect(es).toHaveLength(1);
		expect(es[0].id).toBe("t1");
		expect(es[0].endTs).toBe(at(16, 17));
		expect(app.running).toBeNull();
	});

	it("kürzt das Stück, in dem die Endzeit liegt, und löscht nur die danach", async () => {
		laufUeberDreiTage();

		await app.stop(at(18, 10));

		const es = onDisk("2026-07").sort((a, b) => a.startTs - b.startTs);
		expect(es.map((e) => e.id)).toEqual(["t1", "t2", "t3"]);
		expect(es[2].endTs).toBe(at(18, 10)); // t3 gekuerzt, t4 weg
	});

	it("lässt einen Lauf nie spurlos verschwinden", async () => {
		laufUeberDreiTage();

		await app.stop(at(15, 8)); // vor dem Start – unmoeglich

		const es = onDisk("2026-07");
		expect(es).toHaveLength(1);
		expect(es[0].startTs).toBe(at(16, 9));
		expect(es[0].endTs).toBe(at(16, 9)); // Dauer 0 statt negativ
	});

	it("fasst zwei zufällig aneinanderstoßende Einträge nicht zu einem Lauf zusammen", async () => {
		// Manuell erfasst, kein Mitternachts-Stueck: der Vormittag bleibt stehen.
		const vormittag = entry("v", P1, at(17, 8), at(17, 12));
		const laufend = entry("r", P1, at(17, 12), null);
		reset({ "2026-07": [vormittag, laufend] });
		app.running = laufend;

		await app.stop(at(17, 10));

		const es = onDisk("2026-07").sort((a, b) => a.startTs - b.startTs);
		expect(es).toHaveLength(2);
		expect(es[0].endTs).toBe(at(17, 12)); // unangetastet
	});

	it("runSeconds zählt den ganzen Lauf, nicht nur das Stück seit Mitternacht", () => {
		laufUeberDreiTage();
		app.now = at(19, 9);

		expect(app.runStartTs).toBe(at(16, 9));
		expect(app.runSeconds).toBe(3 * 24 * 3600);
	});
});

describe("Rückdatierter Start kürzt einen Eintrag über mehrere Tage", () => {
	it("teilt den gekürzten Eintrag an Mitternacht, statt eine Mehrtages-Zeile zu lassen", async () => {
		// Vergessener Timer vom 16., neuer Timer am 18. Der alte wird auf den neuen
		// Start gekuerzt – ohne Teilung stuende dort ein Eintrag ueber 49 Stunden.
		vi.useFakeTimers({ now: at(18, 10) });
		try {
			const vergessen = entry("alt", P1, at(16, 9), null);
			reset({ "2026-07": [vergessen] });
			app.running = vergessen;
			app.now = at(18, 10);

			await app.startActivity(P2, at(18, 9));

			const alt = onDisk("2026-07")
				.filter((e) => e.activityId === P1)
				.sort((a, b) => a.startTs - b.startTs);
			expect(alt).toHaveLength(3); // 16., 17., 18. statt einer 49-Stunden-Zeile
			expect(alt[0].endTs).toBe(at(17, 0));
			expect(alt[2].endTs).toBe(at(18, 9));
			expect(app.running?.activityId).toBe(P2);
		} finally {
			vi.useRealTimers();
		}
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

	it("splittet addEntry normal, wenn der Folgetag NICHT abwesend ist", async () => {
		reset();
		const e = await app.addEntry(P1, at(17, 23), at(18, 1));
		expect(e).not.toBeNull();
		const es = onDisk("2026-07").sort((a, b) => a.startTs - b.startTs);
		expect(es).toHaveLength(2);
		expect(es[0].endTs).toBe(at(18, 0));
		expect(es[1].startTs).toBe(at(18, 0));
		expect(es[1].endTs).toBe(at(18, 1));
	});

	it("addEntry (ohne Rueckfrage-Option) lehnt einen Folgetag mit Ganztags-Abwesenheit ab", async () => {
		const urlaub: Entry = { ...entry("v", ABS, at(18, 12), at(18, 12)), dayFraction: 1 };
		reset({ "2026-07": [urlaub] });

		const result = await app.addEntry(P1, at(17, 23), at(18, 1));

		expect(result).toBeNull();
		expect(app.absenceOverridePrompt).toBeNull(); // keine Rueckfrage ohne Opt-in
		expect(onDisk("2026-07")).toHaveLength(1); // nur der Urlaub, nichts angelegt (auch nicht Tag 1)
	});
});

describe("Rueckfrage bei Ganztags-Abwesenheit auf einem Folgetag", () => {
	it("addEntry mit confirmAbsenceOverride zeigt eine Rueckfrage statt zu schreiben", async () => {
		const urlaub: Entry = { ...entry("v", ABS, at(18, 12), at(18, 12)), dayFraction: 1 };
		reset({ "2026-07": [urlaub] });

		const result = await app.addEntry(
			P1,
			at(17, 23),
			at(18, 1),
			"",
			"manual",
			undefined,
			{ confirmAbsenceOverride: true }
		);

		expect(result).toBeNull();
		expect(onDisk("2026-07")).toHaveLength(1); // noch nichts veraendert
		expect(app.absenceOverridePrompt?.kind).toBe("add");
		expect(app.absenceOverridePrompt?.days).toHaveLength(1);
		expect(app.absenceOverridePrompt?.days[0].entry.id).toBe("v");
	});

	it("confirmAbsenceOverride entfernt die Abwesenheit und legt den Eintrag danach an (add)", async () => {
		const urlaub: Entry = { ...entry("v", ABS, at(18, 12), at(18, 12)), dayFraction: 1 };
		reset({ "2026-07": [urlaub] });
		await app.addEntry(P1, at(17, 23), at(18, 1), "", "manual", undefined, {
			confirmAbsenceOverride: true
		});

		await app.confirmAbsenceOverride();

		expect(app.absenceOverridePrompt).toBeNull();
		const disk = onDisk("2026-07").sort((a, b) => a.startTs - b.startTs);
		expect(disk.find((e) => e.id === "v")).toBeUndefined(); // Abwesenheit entfernt
		const projekt = disk.filter((e) => e.activityId === P1);
		expect(projekt).toHaveLength(2);
		expect(projekt[0].endTs).toBe(at(18, 0));
		expect(projekt[1].startTs).toBe(at(18, 0));
		expect(projekt[1].endTs).toBe(at(18, 1));
	});

	it("updateEntry zeigt dieselbe Rueckfrage, ohne den Eintrag vorher zu veraendern", async () => {
		const urlaub: Entry = { ...entry("v", ABS, at(18, 12), at(18, 12)), dayFraction: 1 };
		const bestehend = entry("e", P1, at(17, 22), at(17, 23));
		reset({ "2026-07": [urlaub, bestehend] });

		const result = await app.updateEntry(at(17, 22), {
			...bestehend,
			endTs: at(18, 1) // reicht jetzt in den Urlaubstag
		});

		expect(result).toBe(false);
		expect(app.absenceOverridePrompt?.kind).toBe("update");
		expect(app.absenceOverridePrompt?.days[0].entry.id).toBe("v");
		const disk = onDisk("2026-07").find((e) => e.id === "e")!;
		expect(disk.endTs).toBe(at(17, 23)); // unveraendert, solange die Rueckfrage offen ist
	});

	it("confirmAbsenceOverride entfernt die Abwesenheit und uebernimmt die Bearbeitung (update)", async () => {
		const urlaub: Entry = { ...entry("v", ABS, at(18, 12), at(18, 12)), dayFraction: 1 };
		const bestehend = entry("e", P1, at(17, 22), at(17, 23));
		reset({ "2026-07": [urlaub, bestehend] });
		await app.updateEntry(at(17, 22), { ...bestehend, endTs: at(18, 1) });

		await app.confirmAbsenceOverride();

		expect(app.absenceOverridePrompt).toBeNull();
		const disk = onDisk("2026-07").sort((a, b) => a.startTs - b.startTs);
		expect(disk.find((e) => e.id === "v")).toBeUndefined();
		const e = disk.find((x) => x.id === "e")!;
		expect(e.startTs).toBe(at(17, 22));
		expect(e.endTs).toBe(at(18, 0)); // Tag 1 behaelt die id, endet an Mitternacht
		const folgetag = disk.find((x) => x.id !== "e" && x.activityId === P1)!;
		expect(folgetag.startTs).toBe(at(18, 0));
		expect(folgetag.endTs).toBe(at(18, 1));
	});
});

describe("#reportConflict über Monatsgrenzen", () => {
	it("erkennt eine Überschneidung, wenn der Kandidat über den Monatswechsel reicht", async () => {
		// Vorher pruefte #reportConflict nur den Monat von candidate.startTs (Juli) –
		// ein Eintrag am 1. August war fuer den Ueberschneidungs-Check unsichtbar.
		const augustStart = new Date(2026, 7, 1, 0, 0, 0).getTime();
		const bestehend = entry("aug", P2, augustStart, augustStart + 30 * 60 * 1000); // 00:00–00:30
		reset({ "2026-08": [bestehend] });

		const silvester = new Date(2026, 6, 31, 23, 45, 0).getTime();
		const ende = new Date(2026, 7, 1, 0, 15, 0).getTime(); // überschneidet 00:00–00:15 mit "aug"
		const result = await app.addEntry(P1, silvester, ende);

		expect(result).toBeNull();
		expect(onDisk("2026-07")).toHaveLength(0);
		expect(onDisk("2026-08")).toHaveLength(1); // nur der bestehende Eintrag
	});

	it("lässt einen anstoßenden (nicht überschneidenden) Monatswechsel weiterhin zu", async () => {
		const augustStart = new Date(2026, 7, 1, 0, 15, 0).getTime();
		const bestehend = entry("aug", P2, augustStart, augustStart + 30 * 60 * 1000); // 00:15–00:45
		reset({ "2026-08": [bestehend] });

		const silvester = new Date(2026, 6, 31, 23, 45, 0).getTime();
		const ende = new Date(2026, 7, 1, 0, 15, 0).getTime(); // endet genau, wo "aug" beginnt
		const result = await app.addEntry(P1, silvester, ende);

		expect(result).not.toBeNull();
	});
});

describe("init() – was der Ladebildschirm anzeigt", () => {
	// Der Zustand ist ein Singleton: nach diesen Tests muss er wieder "nicht
	// geladen" sein, sonst haengt der Sekunden-Tick in der Suite weiter.
	afterEach(() => {
		app.dispose();
		app.loaded = false;
		app.initStep = null;
		app.initError = null;
	});

	it("meldet Schritt und Meldung, statt still im Ladebildschirm zu bleiben", async () => {
		reset();
		app.loaded = false;
		fsFaults.existsThrows = true; // fs-Plugin antwortet nicht (z.B. fehlende Berechtigung)

		const ok = await app.init();

		expect(ok).toBe(false);
		expect(app.loaded).toBe(false);
		expect(app.initError?.step).toBe("Einstellungen suchen");
		expect(app.initError?.message).toContain("forbidden");
	});

	it("laedt nach einem Fehlversuch beim naechsten Anlauf normal", async () => {
		reset();
		app.loaded = false;
		fsFaults.existsThrows = true;
		expect(await app.init()).toBe(false);

		fsFaults.existsThrows = false;
		const ok = await app.init();

		expect(ok).toBe(true);
		expect(app.loaded).toBe(true);
		expect(app.initError).toBeNull();
		expect(app.initStep).toBeNull();
	});
});

describe("devSimulateStartFault() – Ladebildschirm vorführen", () => {
	afterEach(() => {
		app.dispose();
		app.loaded = false;
		app.devFail = null;
		app.initStep = null;
		app.initError = null;
	});

	it("nimmt den echten Fehlerweg und lässt sich danach normal starten", async () => {
		const laufend = entry("r", P1, at(17, 9), null);
		reset({ "2026-07": [laufend] });
		app.loaded = true; // App laeuft bereits
		const vorher = files.get(monthFile("2026-07"));

		await app.devSimulateStartFault("error");

		expect(app.loaded).toBe(false);
		expect(app.initError?.step).toContain("Einträge");
		expect(app.initError?.message).toContain("Dev-Menü");
		// Nichts angefasst: der gestoerte Schritt laeuft gar nicht erst an.
		expect(files.get(monthFile("2026-07"))).toBe(vorher);

		// „Erneut versuchen": die Stoerung gilt nur einmal.
		expect(await app.init()).toBe(true);
		expect(app.initError).toBeNull();
		expect(app.initStep).toBeNull();
	});

	it("hält den Start nur auf – und läuft von selbst weiter", async () => {
		vi.useFakeTimers();
		try {
			reset();
			app.loaded = true;
			const start = app.devSimulateStartFault("hang");

			await vi.advanceTimersByTimeAsync(1000);
			expect(app.loaded).toBe(false); // steht im Ladebildschirm …
			expect(app.initStep).toContain("Einträge"); // … und sagt, woran
			expect(app.initError).toBeNull(); // kein Fehler, nur langsam

			await vi.advanceTimersByTimeAsync(20_000);
			await start;
			expect(app.loaded).toBe(true);
		} finally {
			vi.useRealTimers();
		}
	});
});
