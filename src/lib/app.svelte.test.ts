import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Activity, Entry } from "./types";
import { BUILTIN_ABSENCE_ID, BUILTIN_OTHERS_ID, defaultSettings } from "./types";
import { fakeFs, files, fsFaults, resetFakeFs } from "./testing/fakeFs";
import { appTimeZone, wallToTs } from "./tz";

vi.mock("@tauri-apps/plugin-fs", async () => (await import("./testing/fakeFs")).fakeFs);
// Toasts sind hier Beiwerk; die Meldungen selbst prueft niemand.
vi.mock("svelte-sonner", () => import("./testing/toastStub"));

const { app } = await import("./app.svelte");

const P1 = "p1";
const P2 = "p2";
const ABS = "abs";
const ACTIVITIES: Activity[] = [
	{ id: P1, name: "Projekt 1", sortOrder: 0, archived: false, isAbsence: false },
	{ id: P2, name: "Projekt 2", sortOrder: 1, archived: false, isAbsence: false },
	{ id: ABS, name: "Abwesenheiten", sortOrder: 2, archived: false, isAbsence: true }
];

const at = (day: number, h: number, min = 0) => wallToTs(2026, 7, day, h, min, 0);
const monthFile = (m: string) => `data/entries-${m}.json`;
const onDisk = (m: string): Entry[] => JSON.parse(files.get(monthFile(m)) ?? "[]");

/** Frischer App-Zustand ohne init() – das wuerde den Sekunden-Tick starten. */
function reset(entries: Record<string, Entry[]> = {}) {
	resetFakeFs();
	// Ein KONFIGURIERTES Konto nachstellen: ohne gespeicherte Zeitzone uebernaehme
	// reload() die des Geraets und die Suite prueft dann nur noch sich selbst.
	files.set(
		"data/settings.json",
		JSON.stringify({ ...defaultSettings, timeZone: appTimeZone() })
	);
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
		const ongoing = entry("r", P1, at(16, 23, 25), null);
		reset({ "2026-07": [ongoing] });
		app.running = ongoing;

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
		const newYearsEve = wallToTs(2026, 7, 31, 23, 0, 0);
		const ongoing = entry("r", P1, newYearsEve, null);
		reset({ "2026-07": [ongoing] });
		app.running = ongoing;

		await app.stop(wallToTs(2026, 8, 1, 1, 0, 0));

		expect(onDisk("2026-07")).toHaveLength(1);
		expect(onDisk("2026-08")).toHaveLength(1);
		expect(onDisk("2026-08")[0].startTs).toBe(wallToTs(2026, 8, 1, 0, 0, 0));
	});

	it("lässt einen Timer innerhalb eines Tages ungeteilt", async () => {
		const ongoing = entry("r", P1, at(17, 8), null);
		reset({ "2026-07": [ongoing] });
		app.running = ongoing;

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
	function runsOverThreeDays() {
		const pieces = [
			entry("t1", P1, at(16, 9), at(17, 0)),
			entry("t2", P1, at(17, 0), at(18, 0)),
			entry("t3", P1, at(18, 0), at(19, 0)),
			entry("t4", P1, at(19, 0), null)
		];
		reset({ "2026-07": pieces });
		app.running = pieces[3];
		return pieces;
	}

	it("räumt die Tagesstücke weg, die nach der eingetragenen Endzeit liegen", async () => {
		runsOverThreeDays();

		await app.stop(at(16, 17)); // "aufgehört habe ich am 16. um 17 Uhr"

		const es = onDisk("2026-07");
		expect(es).toHaveLength(1);
		expect(es[0].id).toBe("t1");
		expect(es[0].endTs).toBe(at(16, 17));
		expect(app.running).toBeNull();
	});

	it("kürzt das Stück, in dem die Endzeit liegt, und löscht nur die danach", async () => {
		runsOverThreeDays();

		await app.stop(at(18, 10));

		const es = onDisk("2026-07").sort((a, b) => a.startTs - b.startTs);
		expect(es.map((e) => e.id)).toEqual(["t1", "t2", "t3"]);
		expect(es[2].endTs).toBe(at(18, 10)); // t3 gekuerzt, t4 weg
	});

	it("lässt einen Lauf nie spurlos verschwinden", async () => {
		runsOverThreeDays();

		await app.stop(at(15, 8)); // vor dem Start – unmoeglich

		const es = onDisk("2026-07");
		expect(es).toHaveLength(1);
		expect(es[0].startTs).toBe(at(16, 9));
		expect(es[0].endTs).toBe(at(16, 9)); // Dauer 0 statt negativ
	});

	/**
	 * Zwei offene Stuecke desselben Laufs, getrennt an Mitternacht - das
	 * Folgestueck laeuft.
	 */
	function twoOpenPieces(): void {
		const prevDay = entry("t1", P1, at(16, 9), null);
		const followUp = entry("t2", P1, at(17, 0), null);
		reset({ "2026-07": [prevDay, followUp] });
		app.running = followUp;
	}

	it("räumt das Folgestück auch dann weg, wenn beide Stücke offen stehen", async () => {
		// Aus dem Protokoll: die Mitternachts-Teilung hat das Vorgaengerstueck offen
		// stehen lassen, damit fehlte das Bindeglied `endTs`. Das Folgestueck galt
		// als eigener Lauf, dessen Beginn schon hinter der Endzeit lag – und blieb
		// als Eintrag ueber 00:00–00:00 zurueck.
		twoOpenPieces();

		await app.stop(at(16, 19)); // "aufgehört habe ich gestern um 19 Uhr"

		const es = onDisk("2026-07");
		expect(es).toHaveLength(1);
		expect(es[0].id).toBe("t1");
		expect(es[0].endTs).toBe(at(16, 19));
	});

	it("erkennt den Lauf über ein offenes Vorgängerstück hinweg", async () => {
		// Dieselbe Lage, aber die Endzeit liegt im Folgestueck: dann bleiben beide
		// stehen – nur eben als ein Lauf.
		twoOpenPieces();

		await app.stop(at(17, 8));

		const es = onDisk("2026-07").sort((a, b) => a.startTs - b.startTs);
		expect(es.map((e) => e.id)).toEqual(["t1", "t2"]);
		expect(es[0].endTs).toBe(at(17, 0)); // an Mitternacht geschlossen
		expect(es[1].endTs).toBe(at(17, 8));
	});

	it("schließt beide Fortsetzungen, wenn zwei an derselben Mitternacht offen stehen", async () => {
		// Zwei Fenster haben denselben Mitternachts-Wechsel angelegt (die
		// Idempotenz-Wache in #rolloverAtMidnight greift nur, wenn das andere
		// Fenster schon geschrieben hat). Beide Ketten haben denselben Anfang und
		// dieselbe Länge – es darf trotzdem keine offen zurückbleiben.
		const prevDay = entry("t1", P1, at(16, 9), at(17, 0));
		const a = entry("t2a", P1, at(17, 0), null);
		const b = entry("t2b", P1, at(17, 0), null);
		reset({ "2026-07": [prevDay, a, b] });
		app.running = b;

		await app.stop(at(17, 8));

		const es = onDisk("2026-07");
		expect(es.filter((e) => e.endTs === null)).toEqual([]);
		expect(es.find((e) => e.id === "t2a")?.endTs).toBe(at(17, 8));
		expect(es.find((e) => e.id === "t2b")?.endTs).toBe(at(17, 8));
	});

	it("nimmt den exakt anschließenden Vorgänger, nicht eine offen gebliebene Zeile", () => {
		// Beide kämen als Vorgänger in Frage: gleiche Aktivität, Mitternacht des
		// eigenen Tages ist der Start von t2. Ohne Vorrang für den exakten Treffer
		// entschiede die Reihenfolge in der Monatsdatei, wie der Lauf aussieht.
		const forgotten = entry("alt", P1, at(16, 7), null); // nach einem Absturz nie geschlossen
		const real = entry("t1", P1, at(16, 9), at(17, 0));
		const followUp = entry("t2", P1, at(17, 0), null);
		reset({ "2026-07": [forgotten, real, followUp] });

		expect(app.runChain(followUp).map((e) => e.id)).toEqual(["t1", "t2"]);
	});

	it("fasst zwei zufällig aneinanderstoßende Einträge nicht zu einem Lauf zusammen", async () => {
		// Manuell erfasst, kein Mitternachts-Stueck: der Vormittag bleibt stehen.
		const morning = entry("v", P1, at(17, 8), at(17, 12));
		const ongoing = entry("r", P1, at(17, 12), null);
		reset({ "2026-07": [morning, ongoing] });
		app.running = ongoing;

		await app.stop(at(17, 10));

		const es = onDisk("2026-07").sort((a, b) => a.startTs - b.startTs);
		expect(es).toHaveLength(2);
		expect(es[0].endTs).toBe(at(17, 12)); // unangetastet
	});

	it("runSeconds zählt den ganzen Lauf, nicht nur das Stück seit Mitternacht", () => {
		runsOverThreeDays();
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
			const forgotten = entry("alt", P1, at(16, 9), null);
			reset({ "2026-07": [forgotten] });
			app.running = forgotten;
			app.now = at(18, 10);

			await app.startActivity(P2, at(18, 9));

			const old = onDisk("2026-07")
				.filter((e) => e.activityId === P1)
				.sort((a, b) => a.startTs - b.startTs);
			expect(old).toHaveLength(3); // 16., 17., 18. statt einer 49-Stunden-Zeile
			expect(old[0].endTs).toBe(at(17, 0));
			expect(old[2].endTs).toBe(at(18, 9));
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
		const vacation: Entry = { ...entry("v", ABS, at(17, 12), at(17, 12)), dayFraction: 1 };
		reset({ "2026-07": [vacation] });
		expect(await app.addEntry(P1, at(17, 8), at(17, 12))).toBeNull();
	});
});

describe("Zeitausgleich", () => {
	it("legt ihn auf der Abwesenheits-Zeile an und merkt sich die Art", async () => {
		// Keine eigene Aktivitaet: der Unterschied steckt allein im Eintrag.
		reset();
		const created = await app.addEntry(ABS, at(17, 12), at(17, 12), "", "manual", 1, {
			timeOff: true
		});
		expect(created?.activityId).toBe(ABS);
		expect(onDisk("2026-07")[0].timeOff).toBe(true);
		expect(app.isTimeOff(onDisk("2026-07")[0])).toBe(true);
	});

	it("schreibt an einen gewoehnlichen Urlaubstag gar kein Merkmal", async () => {
		// Ein `timeOff: false` an jedem Eintrag waere eine inhaltliche Aenderung
		// und schickte beim naechsten Abgleich den halben Bestand erneut hoch.
		reset();
		await app.addEntry(ABS, at(17, 12), at(17, 12), "", "manual", 1);
		expect("timeOff" in onDisk("2026-07")[0]).toBe(false);
	});

	it("sperrt einen ganzen Tag genauso wie ein Urlaubstag", async () => {
		// Wer den Tag abfeiert, arbeitet an ihm nicht.
		reset();
		await app.addEntry(ABS, at(17, 12), at(17, 12), "", "manual", 1, { timeOff: true });
		expect(await app.addEntry(P1, at(17, 8), at(17, 12))).toBeNull();
	});

	it("laesst Projektzeit neben einem halben Tag zu", async () => {
		// Vormittags arbeiten, nachmittags abfeiern - der Sinn des halben Tages.
		reset();
		await app.addEntry(ABS, at(17, 12), at(17, 12), "", "manual", 0.5, { timeOff: true });
		expect(await app.addEntry(P1, at(17, 8), at(17, 12))).not.toBeNull();
	});

	it("traegt einen ganzen Zeitraum als Zeitausgleich ein", async () => {
		reset();
		const { added } = await app.addAbsenceRange("2026-07-13", "2026-07-15", 1, true);
		expect(added).toBe(3);
		expect(onDisk("2026-07").every((e) => e.timeOff === true)).toBe(true);
	});
});

describe("deleteYearEntries", () => {
	it("löscht nur das genannte Jahr – aus Datei UND Cache", async () => {
		reset({
			"2025-12": [entry("alt", P1, wallToTs(2025, 12, 1, 8, 0, 0), wallToTs(2025, 12, 1, 9, 0, 0))],
			"2026-07": [entry("neu", P1, at(17, 8), at(17, 9))]
		});

		expect(await app.deleteYearEntries(2025)).toBe(1);

		expect(files.has(monthFile("2025-12"))).toBe(false);
		expect(app.entriesByMonth["2025-12"]).toBeUndefined(); // Cache mit geraeumt
		expect(onDisk("2026-07")).toHaveLength(1);
	});

	it("stoppt einen Timer, der im gelöschten Jahr läuft", async () => {
		const ongoing = entry("r", P1, wallToTs(2025, 12, 1, 8, 0, 0), null);
		reset({ "2025-12": [ongoing] });
		app.running = ongoing;

		await app.deleteYearEntries(2025);

		expect(app.running).toBeNull();
	});

	it("meldet die Änderung, damit abgeleitete Listen neu lesen", async () => {
		reset({ "2025-12": [entry("alt", P1, wallToTs(2025, 12, 1, 8, 0, 0), wallToTs(2025, 12, 1, 9, 0, 0))] });
		const previous = app.entriesVersion;
		await app.deleteYearEntries(2025);
		expect(app.entriesVersion).toBeGreaterThan(previous);
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
		// Absturz um 12, danach neu gestartet: der 09–12-Block ist echte Arbeit und
		// muss eine echte Dauer behalten, nicht endTs = startTs.
		await reloadAt(at(17, 15), [entry("alt", P1, at(17, 9), null), entry("neu", P2, at(17, 12), null)]);

		const old = onDisk("2026-07").find((e) => e.id === "alt")!;
		expect(old.endTs).toBe(at(17, 12)); // nicht at(17, 9)
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

		const closed = onDisk("2026-07").filter((e) => e.endTs !== null);
		expect(closed).toHaveLength(1);
		expect(closed[0].endTs).toBe(closed[0].startTs);
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
		const vacation: Entry = { ...entry("v", ABS, at(17, 12), at(17, 12)), dayFraction: 1 };
		const ongoing = entry("r", P1, at(16, 22), null);
		reset({ "2026-07": [vacation, ongoing] });
		app.running = ongoing;

		await app.stop(at(17, 3));

		const project = onDisk("2026-07").filter((e) => e.activityId === P1);
		expect(project).toHaveLength(1);
		expect(project[0].endTs).toBe(at(17, 0)); // endet an Mitternacht, kein Stueck danach
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
		const vacation: Entry = { ...entry("v", ABS, at(18, 12), at(18, 12)), dayFraction: 1 };
		reset({ "2026-07": [vacation] });

		const result = await app.addEntry(P1, at(17, 23), at(18, 1));

		expect(result).toBeNull();
		expect(app.absenceOverridePrompt).toBeNull(); // keine Rueckfrage ohne Opt-in
		expect(onDisk("2026-07")).toHaveLength(1); // nur der Urlaub, nichts angelegt (auch nicht Tag 1)
	});
});

describe("Rueckfrage bei Ganztags-Abwesenheit auf einem Folgetag", () => {
	it("addEntry mit confirmAbsenceOverride zeigt eine Rueckfrage statt zu schreiben", async () => {
		const vacation: Entry = { ...entry("v", ABS, at(18, 12), at(18, 12)), dayFraction: 1 };
		reset({ "2026-07": [vacation] });

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
		const vacation: Entry = { ...entry("v", ABS, at(18, 12), at(18, 12)), dayFraction: 1 };
		reset({ "2026-07": [vacation] });
		await app.addEntry(P1, at(17, 23), at(18, 1), "", "manual", undefined, {
			confirmAbsenceOverride: true
		});

		await app.confirmAbsenceOverride();

		expect(app.absenceOverridePrompt).toBeNull();
		const disk = onDisk("2026-07").sort((a, b) => a.startTs - b.startTs);
		expect(disk.find((e) => e.id === "v")).toBeUndefined(); // Abwesenheit entfernt
		const project = disk.filter((e) => e.activityId === P1);
		expect(project).toHaveLength(2);
		expect(project[0].endTs).toBe(at(18, 0));
		expect(project[1].startTs).toBe(at(18, 0));
		expect(project[1].endTs).toBe(at(18, 1));
	});

	it("updateEntry zeigt dieselbe Rueckfrage, ohne den Eintrag vorher zu veraendern", async () => {
		const vacation: Entry = { ...entry("v", ABS, at(18, 12), at(18, 12)), dayFraction: 1 };
		const existing = entry("e", P1, at(17, 22), at(17, 23));
		reset({ "2026-07": [vacation, existing] });

		const result = await app.updateEntry(at(17, 22), {
			...existing,
			endTs: at(18, 1) // reicht jetzt in den Urlaubstag
		});

		expect(result).toBe(false);
		expect(app.absenceOverridePrompt?.kind).toBe("update");
		expect(app.absenceOverridePrompt?.days[0].entry.id).toBe("v");
		const disk = onDisk("2026-07").find((e) => e.id === "e")!;
		expect(disk.endTs).toBe(at(17, 23)); // unveraendert, solange die Rueckfrage offen ist
	});

	it("confirmAbsenceOverride entfernt die Abwesenheit und uebernimmt die Bearbeitung (update)", async () => {
		const vacation: Entry = { ...entry("v", ABS, at(18, 12), at(18, 12)), dayFraction: 1 };
		const existing = entry("e", P1, at(17, 22), at(17, 23));
		reset({ "2026-07": [vacation, existing] });
		await app.updateEntry(at(17, 22), { ...existing, endTs: at(18, 1) });

		await app.confirmAbsenceOverride();

		expect(app.absenceOverridePrompt).toBeNull();
		const disk = onDisk("2026-07").sort((a, b) => a.startTs - b.startTs);
		expect(disk.find((e) => e.id === "v")).toBeUndefined();
		const e = disk.find((x) => x.id === "e")!;
		expect(e.startTs).toBe(at(17, 22));
		expect(e.endTs).toBe(at(18, 0)); // Tag 1 behaelt die id, endet an Mitternacht
		const nextDay = disk.find((x) => x.id !== "e" && x.activityId === P1)!;
		expect(nextDay.startTs).toBe(at(18, 0));
		expect(nextDay.endTs).toBe(at(18, 1));
	});
});

describe("Bearbeiten eines anstossenden Timer-Eintrags", () => {
	// Der Eintrags-Dialog zeigt "HH:MM" und baut daraus wieder einen Zeitstempel.
	// Timer-Eintraege stossen aber sekundengenau aneinander: ein Aktivitaetswechsel
	// setzt das Ende des einen exakt auf den Start des naechsten.
	const sec = (day: number, h: number, m: number, s: number) =>
		wallToTs(2026, 7, day, h, m, s);

	/** 11:20:39–14:00:22, direkt gefolgt von 14:00:22–24:00 (Annas 19.08.). */
	function pair() {
		const previous = entry("a", P1, sec(19, 11, 20, 39), sec(19, 14, 0, 22));
		const afterwards = entry("b", P1, sec(19, 14, 0, 22), sec(20, 0, 0, 0));
		reset({ "2026-07": [previous, afterwards] });
		return afterwards;
	}

	it("weist den auf :00 abgerundeten Start ab – der Fehler, den keepSeconds verhindert", async () => {
		const afterwards = pair();
		// Ohne keepSeconds baut der Dialog aus "14:00" die Sekunde 00 und ragt damit
		// 22 Sekunden in den Vorgaenger.
		const ok = await app.updateEntry(afterwards.startTs, {
			...afterwards,
			startTs: sec(19, 14, 0, 0),
			endTs: sec(19, 18, 26, 0)
		});
		expect(ok).toBe(false);
		expect(onDisk("2026-07").find((e) => e.id === "b")!.endTs).toBe(sec(20, 0, 0, 0));
	});

	it("nimmt den Start mit erhaltenen Sekunden an", async () => {
		const afterwards = pair();
		const ok = await app.updateEntry(afterwards.startTs, {
			...afterwards,
			startTs: sec(19, 14, 0, 22), // keepSeconds hat die 22 zurueckgegeben
			endTs: sec(19, 18, 26, 0)
		});
		expect(ok).toBe(true);
		const b = onDisk("2026-07").find((e) => e.id === "b")!;
		expect(b.startTs).toBe(sec(19, 14, 0, 22));
		expect(b.endTs).toBe(sec(19, 18, 26, 0));
	});
});

describe("#reportConflict über Monatsgrenzen", () => {
	it("erkennt eine Überschneidung, wenn der Kandidat über den Monatswechsel reicht", async () => {
		// #reportConflict muss auch den Folgemonat pruefen: ein Kandidat, der ueber
		// den Monatswechsel reicht, darf einen Eintrag am 1. August nicht uebersehen.
		const augustStart = wallToTs(2026, 8, 1, 0, 0, 0);
		const existing = entry("aug", P2, augustStart, augustStart + 30 * 60 * 1000); // 00:00–00:30
		reset({ "2026-08": [existing] });

		const newYearsEve = wallToTs(2026, 7, 31, 23, 45, 0);
		const end = wallToTs(2026, 8, 1, 0, 15, 0); // überschneidet 00:00–00:15 mit "aug"
		const result = await app.addEntry(P1, newYearsEve, end);

		expect(result).toBeNull();
		expect(onDisk("2026-07")).toHaveLength(0);
		expect(onDisk("2026-08")).toHaveLength(1); // nur der bestehende Eintrag
	});

	it("lässt einen anstoßenden (nicht überschneidenden) Monatswechsel weiterhin zu", async () => {
		const augustStart = wallToTs(2026, 8, 1, 0, 15, 0);
		const existing = entry("aug", P2, augustStart, augustStart + 30 * 60 * 1000); // 00:15–00:45
		reset({ "2026-08": [existing] });

		const newYearsEve = wallToTs(2026, 7, 31, 23, 45, 0);
		const end = wallToTs(2026, 8, 1, 0, 15, 0); // endet genau, wo "aug" beginnt
		const result = await app.addEntry(P1, newYearsEve, end);

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
		const ongoing = entry("r", P1, at(17, 9), null);
		reset({ "2026-07": [ongoing] });
		app.loaded = true; // App laeuft bereits
		const previous = files.get(monthFile("2026-07"));

		await app.devSimulateStartFault("error");

		expect(app.loaded).toBe(false);
		expect(app.initError?.step).toContain("Einträge");
		expect(app.initError?.message).toContain("Dev-Menü");
		// Nichts angefasst: der gestoerte Schritt laeuft gar nicht erst an.
		expect(files.get(monthFile("2026-07"))).toBe(previous);

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

describe("ensureMonth", () => {
	it("liest eine Datei auch bei gleichzeitigen Anfragen nur einmal", async () => {
		// Beim Start fragen drei Ansichten gleichzeitig nach ueberlappenden
		// Zwoelfer-Bloecken (Auswertung, Arbeitszeit-Check, Tracking-Hinweis).
		// `ensureMonth` prueft VOR dem await, ob der Monat da ist – ohne
		// Merkliste kaeme jede Anfrage durch, und dieselbe Datei wuerde vierfach
		// gelesen.
		reset();
		files.set(monthFile("2026-03"), JSON.stringify([]));
		const spy = vi.spyOn(fakeFs, "readTextFile");

		await Promise.all([
			app.ensureMonth("2026-03"),
			app.ensureMonth("2026-03"),
			app.ensureMonth("2026-03"),
			app.ensureMonth("2026-03")
		]);

		const read = spy.mock.calls.filter((c) => String(c[0]).includes("entries-2026-03")).length;
		expect(read).toBe(1);
		spy.mockRestore();
	});

	it("laedt nach einem fehlgeschlagenen Versuch erneut", async () => {
		// Die Merkliste darf den Monat nicht dauerhaft blockieren: schlaegt das
		// Lesen fehl, muss der naechste Aufruf es wieder versuchen duerfen.
		reset();
		await app.ensureMonth("2026-04");
		expect(app.monthLoaded("2026-04")).toBe(true);
		app.entriesByMonth = {};
		await app.ensureMonth("2026-04");
		expect(app.monthLoaded("2026-04")).toBe(true);
	});

	it("aktiviert Pomodoro in den Einstellungen, startet Timer und uebersteht reload", async () => {
		reset();
		await app.updateSettings({
			pomodoroEnabled: true,
			pomodoroMin: 25,
			pomodoroBreakMin: 5
		});
		expect(app.settings.pomodoroEnabled).toBe(true);
		expect(app.settings.pomodoroMin).toBe(25);
		expect(app.settings.pomodoroBreakMin).toBe(5);

		// Timer starten
		await app.startActivity(P1);
		expect(app.running).not.toBeNull();
		expect(app.running?.activityId).toBe(P1);
		expect(app.pomodoro).not.toBeNull();
		expect(app.pomodoro?.phase).toBe("focus");

		// Reload simuliert Sync/Fenster-Neuladen
		await app.reload();
		expect(app.settings.pomodoroEnabled).toBe(true);
		expect(app.settings.pomodoroMin).toBe(25);
		expect(app.settings.pomodoroBreakMin).toBe(5);
		expect(app.running?.activityId).toBe(P1);
		expect(app.pomodoro?.phase).toBe("focus");
	});
});

describe("Eingebaute Zeilen: Duplikate zusammenfuehren", () => {
	/** Aktivitaeten auf die Platte legen und die App neu einlesen lassen. */
	async function withActivities(list: Activity[], entries: Record<string, Entry[]> = {}) {
		reset(entries);
		files.set("data/activities.json", JSON.stringify(list));
		await app.reload();
	}

	const row = (id: string, name: string, isAbsence: boolean, sortOrder = 0): Activity => ({
		id,
		name,
		sortOrder,
		archived: false,
		isAbsence
	});

	it("macht aus drei 'Others' und drei 'Abwesenheiten' je eine", async () => {
		// Genau der gemeldete Zustand: jedes Geraet hatte eigene Zufalls-Ids vergeben.
		await withActivities([
			row("zufall-1", "Others", false, 0),
			row("zufall-2", "Others", false, 1),
			row("zufall-3", "Others", false, 2),
			row("zufall-4", "Abwesenheiten", true, 3),
			row("zufall-5", "Abwesenheiten", true, 4),
			row("zufall-6", "Abwesenheiten", true, 5),
			row(P1, "Projekt 1", false, 6)
		]);

		expect(app.activities.filter((a) => a.name === "Others")).toHaveLength(1);
		expect(app.activities.filter((a) => a.isAbsence)).toHaveLength(1);
		expect(app.activities.find((a) => a.name === "Others")?.id).toBe(BUILTIN_OTHERS_ID);
		expect(app.activities.find((a) => a.isAbsence)?.id).toBe(BUILTIN_ABSENCE_ID);
		// Die echte Aktivitaet bleibt unangetastet.
		expect(app.activities.find((a) => a.id === P1)).toBeDefined();
	});

	it("haengt die Eintraege der Duplikate um, statt sie zu loeschen", async () => {
		await withActivities(
			[row("alt-a", "Abwesenheiten", true, 0), row("alt-b", "Abwesenheiten", true, 1)],
			{
				"2026-08": [
					entry("e1", "alt-a", at(3, 9), at(3, 17)),
					entry("e2", "alt-b", at(4, 9), at(4, 17))
				]
			}
		);

		const stored = onDisk("2026-08");
		expect(stored).toHaveLength(2);
		expect(stored.every((e) => e.activityId === BUILTIN_ABSENCE_ID)).toBe(true);
	});

	it("zieht auch eine einzelne Zeile mit Alt-Id auf die feste Id", async () => {
		// Sonst legte ein frisch aufgesetztes Geraet die feste Id an und der
		// Abgleich brachte prompt wieder ein Duplikat.
		await withActivities([row("alt-einzeln", "Abwesenheiten", true, 0)], {
			"2026-08": [entry("e1", "alt-einzeln", at(3, 9), at(3, 17))]
		});

		expect(app.activities.filter((a) => a.isAbsence)).toHaveLength(1);
		expect(app.activities.find((a) => a.isAbsence)?.id).toBe(BUILTIN_ABSENCE_ID);
		expect(onDisk("2026-08")[0].activityId).toBe(BUILTIN_ABSENCE_ID);
	});

	it("behaelt Farbe und Favorit der ueberlebenden Zeile", async () => {
		await withActivities([
			{ ...row("aaa", "Others", false, 0), color: "#22c55e", favorite: true },
			row("bbb", "Others", false, 1)
		]);

		const others = app.activities.find((a) => a.name === "Others");
		expect(others?.color).toBe("#22c55e");
		expect(others?.favorite).toBe(true);
	});

	it("legt fehlende Zeilen mit fester Id an", async () => {
		await withActivities([row(P1, "Projekt 1", false, 0)]);

		expect(app.activities.find((a) => a.name === "Others")?.id).toBe(BUILTIN_OTHERS_ID);
		expect(app.activities.find((a) => a.isAbsence)?.id).toBe(BUILTIN_ABSENCE_ID);
	});

	it("aendert beim zweiten Durchlauf nichts mehr", async () => {
		await withActivities([row("zufall-1", "Others", false, 0), row("zufall-2", "Others", false, 1)]);
		const after = JSON.stringify(app.activities);

		await app.reload();

		expect(JSON.stringify(app.activities)).toBe(after);
	});
});

describe("Reparatur der eingebauten Zeilen erreicht den Abgleich", () => {
	it("merkt umgehaengte Eintraege und geloeschte Zeilen in der Outbox vor", async () => {
		const { startTracking, stopTracking, pendingChanges, resetOutboxForTests } = await import(
			"./sync/outbox"
		);

		reset();
		// Ein bereits abgeglichener Eintrag: er traegt `rev`. Genau solche sammelt
		// rememberUnstamped() NICHT mehr ein - ohne Schreib-Haken bliebe das
		// Umhaengen also auf diesem Geraet stehen.
		files.set(
			"data/activities.json",
			JSON.stringify([
				{ id: "alt-a", name: "Abwesenheiten", sortOrder: 0, archived: false, isAbsence: true, rev: 7 },
				{ id: "alt-b", name: "Abwesenheiten", sortOrder: 1, archived: false, isAbsence: true, rev: 8 }
			])
		);
		files.set(
			"data/entries-2026-08.json",
			JSON.stringify([{ ...entry("e1", "alt-a", at(3, 9), at(3, 17)), rev: 3 }])
		);

		resetOutboxForTests();
		await startTracking("geraet-test");
		try {
			await app.reload();

			const marked = pendingChanges();
			expect(marked.some((c) => c.kind === "entry" && c.id === "e1")).toBe(true);
			expect(marked.some((c) => c.kind === "activity" && c.id === BUILTIN_ABSENCE_ID)).toBe(true);
			// Die Duplikate muessen als Loeschung hochgehen, sonst holt sie der
			// naechste Abgleich zurueck.
			const deletions = marked.filter((c) => c.kind === "activity" && c.deleted).map((c) => c.id);
			expect(deletions).toEqual(expect.arrayContaining(["alt-a", "alt-b"]));
		} finally {
			stopTracking();
			resetOutboxForTests();
		}
	});
});

describe("Reparatur laeuft nicht zweimal ueber dieselbe Liste", () => {
	it("erzeugt bei gleichzeitigen Durchlaeufen keine neuen Duplikate", async () => {
		// reload() wird an mehreren Stellen ohne await angestossen (Fenster-Signal,
		// Abgleich, Tray). Zwei Durchlaeufe lesen dann dieselbe Liste, und der
		// zweite haengt seine Zeile an die des ersten an - dasselbe Duplikat, das
		// hier eigentlich verschwinden soll.
		reset();
		app.activities = [
			{ id: "alt-a", name: "Abwesenheiten", sortOrder: 0, archived: false, isAbsence: true },
			{ id: "alt-b", name: "Abwesenheiten", sortOrder: 1, archived: false, isAbsence: true }
		];

		await Promise.all([app.mergeDuplicateBuiltins(), app.mergeDuplicateBuiltins()]);

		expect(app.activities.filter((a) => a.isAbsence)).toHaveLength(1);
		expect(app.activities.filter((a) => a.id === BUILTIN_ABSENCE_ID)).toHaveLength(1);
	});

	it("gibt der zusammengefuehrten Zeile keinen fremden Stempel mit", async () => {
		// Unter der festen Id entsteht ein NEUER Datensatz. Mit dem `rev` der alten
		// Zeile meldete das Geraet eine Aenderung an einer Fassung, die der Server
		// nie hatte - der erste Abgleich nach dem Update liefe in einen Konflikt.
		reset();
		app.activities = [
			{ id: "alt-a", name: "Abwesenheiten", sortOrder: 0, archived: false, isAbsence: true, rev: 7, updatedAt: 123 },
			{ id: "alt-b", name: "Abwesenheiten", sortOrder: 1, archived: false, isAbsence: true, rev: 8 }
		];

		await app.mergeDuplicateBuiltins();

		const merged = app.activities.find((a) => a.id === BUILTIN_ABSENCE_ID);
		expect(merged?.rev).toBeUndefined();
		expect(merged?.updatedAt).toBeUndefined();
	});
});
