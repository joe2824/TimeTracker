import { describe, expect, it } from "vitest";
import {
	DEFAULT_FILL_OPTIONS,
	distributeDays,
	freeIntervals,
	occupiedIntervals,
	planFill,
	rebalanceShares,
	reconcile,
	splitBlocks,
	targetEntryHours,
	type ReconcileDay
} from "./timeReconcile";
import type { TimeReportDay } from "./timeReport";
import type { Entry } from "./types";
import { noonTs, startOfNextDay, toTs } from "./time";
import { deductBreakFromHours } from "./breaks";

const PROJECT_DE = "act-projekt";
const VACATION = "act-urlaub";
const ABSENCE_IDS = new Set([VACATION]);
const OPTS = { hoursPerDay: 7.5, tolerance: 0.25, absenceIds: ABSENCE_IDS };

let seq = 0;
/** Zeit-Eintrag an einem Tag ("HH:MM"–"HH:MM"). */
function entry(date: string, from: string, to: string, over: Partial<Entry> = {}): Entry {
	return {
		id: `e${seq++}`,
		activityId: PROJECT_DE,
		startTs: toTs(date, from),
		endTs: toTs(date, to),
		note: "",
		source: "manual",
		...over
	};
}

/** Abwesenheits-Eintrag (tagesgenau, start == end == Tagesmitte). */
function absence(date: string, fraction = 1): Entry {
	return {
		id: `a${seq++}`,
		activityId: VACATION,
		startTs: noonTs(date),
		endTs: noonTs(date),
		note: "",
		source: "manual",
		dayFraction: fraction
	};
}

function day(over: Partial<TimeReportDay> = {}): TimeReportDay {
	return { date: "2026-01-12", firstIn: "09:10", lastOut: "17:35", hours: 7.67, flags: [], ...over };
}

/** Minuten ab Mitternacht als "HH:MM" – macht die Erwartungen lesbar. */
const hhmm = (min: number) => `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
const asClock = (blocks: { start: number; end: number }[]) =>
	blocks.map((b) => `${hhmm(b.start)}–${hhmm(b.end)}`);

describe("reconcile", () => {
	it("meldet einen Tag ohne jede Erfassung als fehlend", () => {
		const r = reconcile([day()], [], OPTS);
		expect(r.days[0]).toMatchObject({ status: "missing", tracked: 0 });
		// Auf Minuten gerundet – 7,67 h aus der Datei sind 460 Minuten.
		expect(r.days[0].diff).toBeCloseTo(7.6667, 3);
		expect(r.missing).toBe(1);
		expect(r.missingHours).toBeCloseTo(7.67);
	});

	it("meldet einen Tag Zeitausgleich nicht als zu viel erfasste Zeit", () => {
		// An einem abgefeierten Tag stempelt niemand: LOGA meldet 0 Stunden. Zaehlt
		// der Zeitausgleich hier als erfasste Zeit, steht an JEDEM solchen Tag ein
		// "zu viel" - eine Falschmeldung, und zwar bei jedem einzelnen.
		const timeOff = { ...absence("2026-01-12", 1), timeOff: true };
		const r = reconcile([day({ firstIn: null, lastOut: null, hours: 0 })], [timeOff], OPTS);
		expect(r.days[0].tracked).toBe(0);
		expect(r.days[0].status).toBe("free");
		expect(r.over).toBe(0);
	});

	it("rechnet an einem halben Tag Zeitausgleich nur die gearbeitete Zeit", () => {
		// Vormittags gearbeitet, nachmittags abgefeiert: LOGA kennt genau die
		// gestempelten 3,75 h - mehr darf hier nicht stehen.
		const timeOff = { ...absence("2026-01-12", 0.5), timeOff: true };
		const r = reconcile(
			[day({ firstIn: "08:00", lastOut: "11:45", hours: 3.75 })],
			[entry("2026-01-12", "08:00", "11:45"), timeOff],
			OPTS
		);
		expect(r.days[0].tracked).toBeCloseTo(3.75, 3);
		expect(r.days[0].status).toBe("ok");
	});

	it("laesst einen gewoehnlichen Urlaubstag unangetastet", () => {
		// Urlaub steht in LOGA mit dem Tagessoll - der Abgleich muss ihn weiter
		// als erfasst sehen.
		const r = reconcile([day({ firstIn: null, lastOut: null, hours: 7.5 })], [absence("2026-01-12")], OPTS);
		expect(r.days[0].tracked).toBe(7.5);
		expect(r.days[0].status).toBe("ok");
	});

	it("meldet einen teilweise erfassten Tag", () => {
		const r = reconcile([day()], [entry("2026-01-12", "09:10", "13:00")], OPTS);
		expect(r.days[0].status).toBe("partial");
		expect(r.days[0].tracked).toBeCloseTo(3.8333, 3);
		expect(r.partial).toBe(1);
	});

	it("laesst eine Abweichung innerhalb der Toleranz durchgehen", () => {
		// 7,5 h erfasst gegen 7,67 h laut LOGA – 10 Minuten Unterschied.
		const r = reconcile([day()], [entry("2026-01-12", "09:10", "16:40")], OPTS);
		expect(r.days[0].status).toBe("ok");
		expect(r.ok).toBe(1);
	});

	it("meldet mehr erfasste Zeit als LOGA kennt", () => {
		const r = reconcile([day({ hours: 5.73 })], [entry("2026-01-12", "08:00", "16:00")], OPTS);
		expect(r.days[0].status).toBe("over");
		expect(r.days[0].diff).toBeCloseTo(-2.27);
		expect(r.over).toBe(1);
	});

	it("meldet keinen Ueberhang, solange LOGA nur das Kommen kennt", () => {
		// Der laufende Tag: gestempelt wurde nur das Kommen, „Arbeitszeit taeglich"
		// steht deshalb noch auf 0. Das Erfasste ist dort nicht zu viel, sondern
		// schlicht noch nicht angekommen.
		const r = reconcile(
			[day({ lastOut: null, hours: 0 })],
			[entry("2026-01-12", "09:10", "13:00")],
			OPTS
		);
		expect(r.days[0].status).toBe("open");
		expect(r.over).toBe(0);
	});

	it("meldet fehlende Zeit auch an einem angefangenen Tag", () => {
		// Andere Richtung: was LOGA schon gutgeschrieben hat, wird durch ein
		// spaeteres Gehen nicht weniger – der Fehlbetrag steht.
		const r = reconcile([day({ lastOut: null, hours: 4 })], [], OPTS);
		expect(r.days[0].status).toBe("missing");
	});

	it("haelt ein leeres Wochenende fuer unauffaellig", () => {
		const r = reconcile([day({ date: "2026-01-10", firstIn: null, lastOut: null, hours: 0 })], [], OPTS);
		expect(r.days[0].status).toBe("free");
		expect(r.missing).toBe(0);
	});

	it("meldet erfasste Zeit an einem Tag, den LOGA gar nicht kennt", () => {
		const r = reconcile(
			[day({ date: "2026-01-10", firstIn: null, lastOut: null, hours: 0 })],
			[entry("2026-01-10", "10:00", "12:00")],
			OPTS
		);
		expect(r.days[0].status).toBe("over");
	});

	it("erkennt Urlaub und Feiertag am fehlenden Stempel", () => {
		// LOGA gibt beides identisch aus: voller Tagessatz, keine Stempel.
		const r = reconcile([day({ date: "2026-01-01", firstIn: null, lastOut: null, hours: 7.5 })], [], OPTS);
		expect(r.days[0]).toMatchObject({ looksLikeAbsence: true, absenceFraction: 1, status: "missing" });
	});

	it("erkennt einen halben Abwesenheitstag", () => {
		const r = reconcile([day({ firstIn: null, lastOut: null, hours: 3.75 })], [], OPTS);
		expect(r.days[0]).toMatchObject({ looksLikeAbsence: true, absenceFraction: 0.5 });
	});

	it("haelt einen stempellosen Tag mit krummen Stunden nicht fuer eine Abwesenheit", () => {
		// 3 h sind weder ein halber (3,75) noch ein ganzer Tag (7,5) – als halber
		// Tag gebucht schriebe die App 3,75 h, wo LOGA 3 h meldet.
		const r = reconcile([day({ firstIn: null, lastOut: null, hours: 3 })], [], OPTS);
		expect(r.days[0].looksLikeAbsence).toBe(false);
	});

	it("haelt einen gestempelten Tag nie fuer eine Abwesenheit", () => {
		expect(reconcile([day()], [], OPTS).days[0].looksLikeAbsence).toBe(false);
	});

	it("rechnet eine gebuchte Abwesenheit als erfasste Zeit", () => {
		const r = reconcile(
			[day({ date: "2026-01-05", firstIn: null, lastOut: null, hours: 7.5 })],
			[absence("2026-01-05")],
			OPTS
		);
		expect(r.days[0]).toMatchObject({ status: "ok", tracked: 7.5, blockedByAbsence: true });
	});

	it("merkt sich, wo schon aus einem Report nachgetragen wurde", () => {
		const r = reconcile([day()], [entry("2026-01-12", "09:10", "17:00", { source: "loga" })], OPTS);
		expect(r.days[0].alreadyFilled).toBe(true);
	});

	it("kappt einen offenen Eintrag am Tagesende", () => {
		// Vergessener Timer in einem alten Monat: zaehlt nur bis Mitternacht, nicht bis heute.
		const open: Entry = {
			id: "open",
			activityId: PROJECT_DE,
			startTs: toTs("2026-01-12", "22:00"),
			endTs: null,
			note: "",
			source: "timer"
		};
		const r = reconcile([day()], [open], { ...OPTS, now: toTs("2026-03-01", "12:00") });
		expect(r.days[0].tracked).toBe(2);
	});
});

describe("occupiedIntervals / freeIntervals", () => {
	it("fasst ueberlappende Eintraege zu einer Spanne zusammen", () => {
		const occ = occupiedIntervals(
			[entry("2026-01-12", "09:00", "11:00"), entry("2026-01-12", "10:30", "12:00")],
			"2026-01-12",
			Date.now()
		);
		expect(occ).toEqual([{ start: 540, end: 720 }]);
	});

	it("uebergeht tagesgenaue Abwesenheiten – die belegen keine Uhrzeit", () => {
		expect(occupiedIntervals([absence("2026-01-12")], "2026-01-12", Date.now())).toEqual([]);
	});

	it("rechnet an der Zeitumstellung mit der Wanduhr", () => {
		// 25.10.2026 ist die Rueckstellung: der Tag hat 25 Stunden. Ueber die
		// Differenz zum Tagesbeginn gerechnet laege 14:00 hier bei 13:00.
		const occ = occupiedIntervals([entry("2026-10-25", "14:00", "16:00")], "2026-10-25", Date.now());
		expect(occ).toEqual([{ start: 840, end: 960 }]);
		// 29.03.2026 ist die Vorstellung: 23 Stunden.
		const occ2 = occupiedIntervals([entry("2026-03-29", "14:00", "16:00")], "2026-03-29", Date.now());
		expect(occ2).toEqual([{ start: 840, end: 960 }]);
	});

	it("zaehlt ein Ende an der Tagesgrenze als 24:00, nicht als 00:00", () => {
		const e = entry("2026-01-12", "22:00", "23:00");
		e.endTs = startOfNextDay(e.startTs);
		expect(occupiedIntervals([e], "2026-01-12", Date.now())).toEqual([{ start: 1320, end: 1440 }]);
	});

	it("beachtet nur den gefragten Tag", () => {
		const occ = occupiedIntervals(
			[entry("2026-01-11", "09:00", "17:00"), entry("2026-01-12", "13:00", "14:00")],
			"2026-01-12",
			Date.now()
		);
		expect(occ).toEqual([{ start: 780, end: 840 }]);
	});

	it("schneidet die Luecken aus dem Fenster", () => {
		expect(freeIntervals({ start: 540, end: 1020 }, [{ start: 600, end: 660 }])).toEqual([
			{ start: 540, end: 600 },
			{ start: 660, end: 1020 }
		]);
	});

	it("liefert nichts, wenn das Fenster ganz belegt ist", () => {
		expect(freeIntervals({ start: 540, end: 1020 }, [{ start: 500, end: 1100 }])).toEqual([]);
	});
});

/** Einen Tag durch reconcile schicken, um an ein vollstaendiges ReconcileDay zu kommen. */
function reconcileOne(report: TimeReportDay, entries: Entry[] = []): ReconcileDay {
	return reconcile([report], entries, OPTS).days[0];
}

describe("planFill", () => {
	it("legt die Pause in den Nachtrag, statt quer durch die Mittagszeit zu buchen", () => {
		// 09:10–17:35 sind 8,42 h Anwesenheit, LOGA zaehlt 7,67 h -> 45 min Pause.
		const plan = planFill(reconcileOne(day()), [], DEFAULT_FILL_OPTIONS)!;
		expect(plan.kind).toBe("time");
		expect(asClock(plan.blocks)).toEqual(["09:10–12:00", "12:45–17:35"]);
		expect(plan.hours).toBeCloseTo(7.67, 2);
	});

	it("fuellt nur die Luecken um bereits erfasste Zeit herum", () => {
		const present = [entry("2026-01-12", "09:10", "11:00")];
		const plan = planFill(reconcileOne(day(), present), present, DEFAULT_FILL_OPTIONS)!;
		expect(asClock(plan.blocks)).toEqual(["11:00–12:00", "12:45–17:35"]);
		// Vorhandenes plus Nachtrag ergibt die LOGA-Stunden.
		expect(plan.hours + 1.8333).toBeCloseTo(7.67, 1);
	});

	it("kommt ohne Pausenluecke aus, wenn der Platz genau reicht", () => {
		// Anwesenheit == Nettozeit: es gibt keine Pause zu beruecksichtigen.
		const plan = planFill(reconcileOne(day({ firstIn: "09:00", lastOut: "17:00", hours: 8 })), [])!;
		expect(asClock(plan.blocks)).toEqual(["09:00–17:00"]);
	});

	it("haengt den Nachtrag hinten an, wenn vor der Mittagszeit nichts frei ist", () => {
		const present = [entry("2026-01-12", "09:10", "13:00")];
		const plan = planFill(reconcileOne(day(), present), present)!;
		// Frei ist 13:00–17:35 (275 min), fehlen 230 min -> 45 min Pause bleiben vorne.
		expect(asClock(plan.blocks)).toEqual(["13:45–17:35"]);
	});

	it("nutzt ohne Stempel ein Ersatzfenster ab dem Standardbeginn", () => {
		const plan = planFill(reconcileOne(day({ firstIn: null, lastOut: null, hours: 3 })), [])!;
		expect(plan.kind).toBe("time");
		expect(asClock(plan.blocks)).toEqual(["09:00–12:00"]);
	});

	it("schlaegt fuer Urlaub und Feiertag eine Abwesenheit vor, kein Projekt", () => {
		const plan = planFill(reconcileOne(day({ date: "2026-01-01", firstIn: null, lastOut: null, hours: 7.5 })), [])!;
		expect(plan).toMatchObject({ kind: "absence", fraction: 1 });
		expect(plan.blocks).toEqual([]);
	});

	it("schlaegt keine Ganztags-Abwesenheit vor, wo schon Projektzeit liegt", () => {
		// App-Regel: beides am selben Tag schliesst sich aus – addEntry wiese den
		// Vorschlag beim Uebernehmen mit einer Fehlermeldung ab.
		const present = [entry("2026-01-05", "09:00", "12:00")];
		const tag = day({ date: "2026-01-05", firstIn: null, lastOut: null, hours: 7.5 });
		expect(reconcileOne(tag, present).looksLikeAbsence).toBe(true);
		expect(planFill(reconcileOne(tag, present), present)).toBeNull();
	});

	it("schlaegt einen halben freien Tag auch neben Projektzeit vor", () => {
		// Ein halber Urlaubstag darf neben Projektzeit liegen.
		const present = [entry("2026-01-05", "09:00", "12:00")];
		const tag = day({ date: "2026-01-05", firstIn: null, lastOut: null, hours: 3.75 });
		expect(planFill(reconcileOne(tag, present), present)).toMatchObject({
			kind: "absence",
			fraction: 0.5
		});
	});

	it("schlaegt fuer einen halben freien Tag einen halben vor", () => {
		const plan = planFill(reconcileOne(day({ firstIn: null, lastOut: null, hours: 3.75 })), [])!;
		expect(plan).toMatchObject({ kind: "absence", fraction: 0.5 });
	});

	it("traegt an einem Ganztags-Abwesenheitstag nichts nach", () => {
		// App-Regel: dort gibt es keine Projektzeit, addEntry wuerde es ohnehin ablehnen.
		const present = [absence("2026-01-12")];
		expect(planFill(reconcileOne(day(), present), present)).toBeNull();
	});

	it("traegt keine Minutenkrümel an einem Tag nach, der stimmt", () => {
		// 8,55 h laut LOGA gegen 8,50 h erfasst: innerhalb der Toleranz, also
		// „stimmt". Am reinen Vorzeichen der Differenz haengend entstuend hier ein
		// Nachtrag ueber drei Minuten – angehakt und mitgezaehlt.
		const present = [entry("2026-01-12", "09:02", "17:32")];
		const tag = day({ firstIn: "09:02", lastOut: "18:20", hours: 8.55 });
		const sync = reconcileOne(tag, present);
		expect(sync.status).toBe("ok");
		expect(sync.diff).toBeGreaterThan(0);
		expect(planFill(sync, present)).toBeNull();
	});

	it("bucht keine zweite Abwesenheit neben einem halben Urlaubstag", () => {
		// Ein halber Tag belegt keine Uhrzeit und wird von der App-Regel nicht
		// abgewiesen – ein ganzer Tag daneben ergaebe still 11,25 h.
		const present = [absence("2026-01-05", 0.5)];
		const tag = day({ date: "2026-01-05", firstIn: null, lastOut: null, hours: 7.5 });
		const sync = reconcileOne(tag, present);
		expect(sync).toMatchObject({ hasAbsence: true, blockedByAbsence: false });
		expect(planFill(sync, present)).toBeNull();
	});

	it("traegt nichts nach, wenn nichts fehlt", () => {
		expect(planFill(reconcileOne(day(), [entry("2026-01-12", "09:10", "16:50")]), [])).toBeNull();
	});

	it("verlaengert das Fenster, wenn LOGA mehr meldet als gestempelt wurde", () => {
		// Echter Tag aus dem Report: 11:05–16:52 gestempelt (5,78 h), aber 7,37 h
		// gutgeschrieben – es wurde ausserhalb der Stempelung gearbeitet. Ohne
		// Verlaengerung bliebe der Tag fuer immer als „teilweise" stehen.
		const tag = day({ firstIn: "11:05", lastOut: "16:52", hours: 7.37 });
		const plan = planFill(reconcileOne(tag, []), [])!;
		// Der gestempelte Teil endet punktgenau an „Letztes gehen" …
		expect(asClock(plan.blocks)).toEqual(["11:05–16:52"]);
		// … der Rest wird getrennt ausgewiesen, damit er auf etwas anderes gebucht
		// werden kann.
		expect(plan.extraBlocks).toHaveLength(1);
		expect(plan.extraBlocks[0].start).toBe(1012); // 16:52
		expect(plan.extraHours).toBeCloseTo(7.37 - 5.783, 2);
		expect(plan.hours + plan.extraHours).toBeCloseTo(7.37, 2);
	});

	it("weist nichts als ausserhalb-der-Stempel aus, wenn das Fenster reicht", () => {
		const plan = planFill(reconcileOne(day()), [])!;
		expect(plan.extraBlocks).toEqual([]);
		expect(plan.extraHours).toBe(0);
	});

	it("erfindet keine Anwesenheit, wenn LOGA nur anders abgezogen hat", () => {
		// 06:30–14:00 gestempelt (7,5 h), LOGA zieht nur 15 min ab statt der 45
		// der Hausregel. Die Stempelzeiten sind voll erfasst – der Rest liesse
		// sich nur mit erfundener Zeit schliessen. Also nichts vorschlagen.
		const present = [entry("2026-01-12", "06:30", "14:00")];
		const tag = day({ firstIn: "06:30", lastOut: "14:00", hours: 7.25 });
		const sync = reconcile([tag], present, { ...OPTS, deductBreaks: true }).days[0];
		expect(sync.status).toBe("partial");
		expect(planFill(sync, present, { ...DEFAULT_FILL_OPTIONS, deductBreaks: true })).toBeNull();
	});

	it("bleibt bei einem ueber Mitternacht gestempelten Tag im Tag", () => {
		const plan = planFill(reconcileOne(day({ firstIn: "22:00", lastOut: "02:00", hours: 3.25 })), [])!;
		// Das Fenster endet an Mitternacht – ein Eintrag darueber hinaus gehoerte
		// dem Folgetag und wuerde beim Anlegen ohnehin geteilt.
		expect(asClock(plan.blocks)).toEqual(["22:00–24:00"]);
		expect(plan.hours).toBe(2);
	});
});

describe("Zusammenspiel mit dem automatischen Pausenabzug", () => {
	const WITH_DEDUCTION = { ...OPTS, deductBreaks: true };

	it("rechnet die erfasste Zeit auf derselben Grundlage wie LOGA", () => {
		// Timer lief 08:36–16:49 durch, also 8,22 h brutto. LOGA meldet 7,47 h
		// netto. Ohne Abzug staende der Tag als „zu viel" da, mit Abzug stimmt er.
		const present = [entry("2026-01-12", "08:36", "16:49")];
		const tag = day({ firstIn: "08:36", lastOut: "16:49", hours: 7.47 });

		expect(reconcile([tag], present, OPTS).days[0].status).toBe("over");

		const mit = reconcile([tag], present, WITH_DEDUCTION).days[0];
		expect(mit.status).toBe("ok");
		expect(mit.tracked).toBeCloseTo(7.47, 2);
		// Die Brutto-Zeit bleibt daneben erhalten.
		expect(mit.workedGross).toBeCloseTo(8.2167, 3);
	});

	it("zieht die Pause nicht von einem Urlaubstag ab", () => {
		const present = [absence("2026-01-05", 1)];
		const tag = day({ date: "2026-01-05", firstIn: null, lastOut: null, hours: 7.5 });
		expect(reconcile([tag], present, WITH_DEDUCTION).days[0]).toMatchObject({
			tracked: 7.5,
			status: "ok"
		});
	});

	it("traegt die ANWESENHEIT nach, nicht die Nettozeit", () => {
		// 7,67 h eins zu eins eingetragen bekaemen den Abzug ein zweites Mal und
		// der Tag bliebe bei 6,92 h stehen. Gebraucht werden 8,42 h Anwesenheit.
		const tag = day({ firstIn: "09:10", lastOut: "17:35", hours: 7.67 });
		const plan = planFill(reconcileOne(tag, []), [], {
			...DEFAULT_FILL_OPTIONS,
			deductBreaks: true
		})!;
		// Keine Pausenluecke: der Block spannt die Anwesenheit auf.
		expect(asClock(plan.blocks)).toEqual(["09:10–17:35"]);
		expect(plan.hours).toBeCloseTo(8.4167, 3);
		// Und nach dem Abzug kommt genau die LOGA-Zahl heraus.
		expect(deductBreakFromHours(plan.hours)).toBeCloseTo(7.67, 2);
	});

	it("beruecksichtigt beim Teil-Nachtrag die schon erfasste Brutto-Zeit", () => {
		const present = [entry("2026-01-12", "09:10", "11:00")]; // 1,833 h brutto
		const tag = day({ firstIn: "09:10", lastOut: "17:35", hours: 7.67 });
		const sync = reconcile([tag], present, WITH_DEDUCTION).days[0];
		const plan = planFill(sync, present, { ...DEFAULT_FILL_OPTIONS, deductBreaks: true })!;
		expect(asClock(plan.blocks)).toEqual(["11:00–17:35"]);
		// Brutto des ganzen Tages danach: 1,833 + 6,583 = 8,417 -> netto 7,67.
		expect(deductBreakFromHours(sync.workedGross + plan.hours)).toBeCloseTo(7.67, 2);
	});

	it("spart die Pause weiterhin aus, wenn der Abzug aus ist", () => {
		const plan = planFill(reconcileOne(day()), [], DEFAULT_FILL_OPTIONS)!;
		expect(asClock(plan.blocks)).toEqual(["09:10–12:00", "12:45–17:35"]);
	});
});

describe("targetEntryHours", () => {
	it("gibt dem einzigen Eintrag des Tages die LOGA-Stunden", () => {
		expect(targetEntryHours(7.67, 0, 0)).toBeCloseTo(7.67);
	});

	it("zieht ab, was am Tag sonst noch steht", () => {
		// 2 h stehen schon auf einem anderen Projekt -> hier bleiben 5,67 h.
		expect(targetEntryHours(7.67, 2, 0)).toBeCloseTo(5.67);
	});

	it("zielt bei aktivem Abzug auf die Anwesenheit, nicht auf die Nettozeit", () => {
		// 7,67 h netto brauchen 8,42 h erfasste Zeit – sonst bekaeme die Zahl den
		// Pausenabzug ein zweites Mal.
		expect(targetEntryHours(7.67, 0, 0, true)).toBeCloseTo(8.42, 2);
		expect(deductBreakFromHours(targetEntryHours(7.67, 0, 0, true))).toBeCloseTo(7.67, 2);
	});

	it("rechnet den Abzug ueber den GANZEN Tag, nicht ueber den einzelnen Eintrag", () => {
		// 1,833 h stehen schon: zusammen muessen 8,42 h herauskommen.
		const target = targetEntryHours(7.67, 1.8333, 0, true);
		expect(deductBreakFromHours(1.8333 + target)).toBeCloseTo(7.67, 2);
	});

	it("nimmt eine Abwesenheit vom Ziel herunter", () => {
		// Halber Urlaubstag (3,75 h) neben halb gearbeitet: LOGA meldet 7,5 h.
		expect(targetEntryHours(7.5, 0, 3.75)).toBeCloseTo(3.75);
	});

	it("wird negativ, wenn der Tag auch ohne diesen Eintrag schon zu voll ist", () => {
		// Der Aufrufer erkennt daran, dass sich das ueber diesen Eintrag allein
		// nicht regeln laesst – kuerzer als leer geht nicht.
		expect(targetEntryHours(4, 6, 0)).toBeCloseTo(-2);
	});
});

describe("splitBlocks", () => {
	/** Blöcke als "HH:MM–HH:MM" – wie oben, nur für die Verteilung. */
	function asText(blocks: { start: number; end: number }[]): string[] {
		const hhmm = (m: number) =>
			`${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
		return blocks.map((b) => `${hhmm(b.start)}–${hhmm(b.end)}`);
	}

	const A = "act-a";
	const B = "act-b";
	const C = "act-c";

	it("teilt einen durchgehenden Tag nach Anteilen der Reihe nach auf", () => {
		// 08:00–16:00 = 480 Minuten, 60/40 -> 288 / 192.
		const parts = splitBlocks([{ start: 480, end: 960 }], [
			{ id: A, share: 0.6 },
			{ id: B, share: 0.4 }
		]);
		expect(parts.map((p) => p.id)).toEqual([A, B]);
		expect(asText(parts[0].blocks)).toEqual(["08:00–12:48"]);
		expect(asText(parts[1].blocks)).toEqual(["12:48–16:00"]);
	});

	it("schneidet ueber eine Pausenluecke hinweg weiter", () => {
		// 08:00–12:00 und 12:45–16:45 = 480 Minuten, halbe/halbe.
		const parts = splitBlocks(
			[
				{ start: 480, end: 720 },
				{ start: 765, end: 1005 }
			],
			[
				{ id: A, share: 0.5 },
				{ id: B, share: 0.5 }
			]
		);
		expect(asText(parts[0].blocks)).toEqual(["08:00–12:00"]);
		expect(asText(parts[1].blocks)).toEqual(["12:45–16:45"]);
	});

	it("gibt den Rundungsrest an das letzte Projekt, nichts geht verloren", () => {
		const blocks = [{ start: 480, end: 941 }]; // 461 Minuten, glatt nicht teilbar
		const parts = splitBlocks(blocks, [
			{ id: A, share: 1 },
			{ id: B, share: 1 },
			{ id: C, share: 1 }
		]);
		const minutes = parts.flatMap((p) => p.blocks).reduce((s, b) => s + (b.end - b.start), 0);
		expect(minutes).toBe(461);
		// Lueckenlos und in der Reihenfolge der Uhr.
		expect(asText(parts.flatMap((p) => p.blocks))).toEqual([
			"08:00–10:34",
			"10:34–13:08",
			"13:08–15:41"
		]);
	});

	it("laesst Projekte ohne Anteil weg", () => {
		const parts = splitBlocks([{ start: 480, end: 960 }], [
			{ id: A, share: 1 },
			{ id: B, share: 0 },
			{ id: "", share: 5 }
		]);
		expect(parts.map((p) => p.id)).toEqual([A]);
		expect(asText(parts[0].blocks)).toEqual(["08:00–16:00"]);
	});
});

describe("distributeDays", () => {
	const A = "act-a";
	const B = "act-b";

	/** Zehn gleich lange Tage – dann muss 60/40 exakt aufgehen. */
	const tenDays = Array.from({ length: 10 }, (_, i) => ({
		date: `2026-01-${String(i + 1).padStart(2, "0")}`,
		hours: 8
	}));

	it("trifft die Anteile ueber gleich lange Tage genau", () => {
		const mapping = distributeDays(tenDays, [
			{ id: A, share: 0.6 },
			{ id: B, share: 0.4 }
		]);
		const count = Object.values(mapping).filter((id) => id === A).length;
		expect(count).toBe(6);
		expect(Object.keys(mapping)).toHaveLength(10);
	});

	it("wiegt lange Tage staerker als kurze", () => {
		// 12 h + 2 h + 2 h: haelftig heisst NICHT „drei Tage durch zwei".
		const days = [
			{ date: "2026-01-01", hours: 12 },
			{ date: "2026-01-02", hours: 2 },
			{ date: "2026-01-03", hours: 2 }
		];
		const mapping = distributeDays(days, [
			{ id: A, share: 0.5 },
			{ id: B, share: 0.5 }
		]);
		// Der lange Tag geht an einen, die beiden kurzen an den anderen.
		expect(mapping["2026-01-02"]).toBe(mapping["2026-01-03"]);
		expect(mapping["2026-01-01"]).not.toBe(mapping["2026-01-02"]);
	});

	it("gibt bei einem einzigen Projekt alle Tage an dieses", () => {
		const mapping = distributeDays(tenDays, [{ id: A, share: 1 }]);
		expect(new Set(Object.values(mapping))).toEqual(new Set([A]));
	});

	it("liefert nichts, wenn kein Projekt einen Anteil hat", () => {
		expect(distributeDays(tenDays, [{ id: A, share: 0 }])).toEqual({});
	});
});

describe("rebalanceShares", () => {
	/** Was auf den Reglern steht, muss immer 100 % ergeben. */
	const sum = (pcts: number[]) => pcts.reduce((s, p) => s + p, 0);

	it("zieht den Rest im Verhaeltnis der uebrigen nach", () => {
		expect(rebalanceShares([50, 50], 0, 70)).toEqual([70, 30]);
		expect(rebalanceShares([60, 20, 20], 0, 40)).toEqual([40, 30, 30]);
	});

	it("bleibt bei vielen kleinen Anteilen auf 100 Prozent", () => {
		// Bei individueller Rundung kaemen hier 101 % heraus, und der letzte
		// Regler fiele dafuer auf 0.
		const next = rebalanceShares([17, 17, 17, 17, 17, 15], 0, 97);
		expect(sum(next)).toBe(100);
		expect(next[0]).toBe(97);
		expect(next.slice(1).every((p) => p >= 0)).toBe(true);
	});

	it("haelt die Summe ueber viele Zuege hinweg", () => {
		let pcts = [20, 20, 20, 20, 20];
		for (const [i, v] of [
			[0, 93],
			[3, 61],
			[1, 7],
			[4, 100],
			[2, 33]
		] as const) {
			pcts = rebalanceShares(pcts, i, v);
			expect(sum(pcts)).toBe(100);
			expect(pcts[i]).toBe(v);
			expect(pcts.every((p) => p >= 0 && p <= 100)).toBe(true);
		}
	});

	it("verteilt gleichmaessig, wenn die uebrigen alle auf null stehen", () => {
		expect(rebalanceShares([100, 0, 0], 0, 40)).toEqual([40, 30, 30]);
	});

	it("laesst einen einzelnen Regler auf 100 stehen", () => {
		expect(rebalanceShares([100], 0, 40)).toEqual([100]);
	});
});
