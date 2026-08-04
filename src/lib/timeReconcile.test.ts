import { describe, expect, it } from "vitest";
import {
	DEFAULT_FILL_OPTIONS,
	freeIntervals,
	occupiedIntervals,
	planFill,
	reconcile,
	type ReconcileDay
} from "./timeReconcile";
import type { TimeReportDay } from "./timeReport";
import type { Entry } from "./types";
import { noonTs, startOfNextDay, toTs } from "./time";
import { deductBreakFromHours } from "./breaks";

const PROJEKT = "act-projekt";
const URLAUB = "act-urlaub";
const ABSENCE_IDS = new Set([URLAUB]);
const OPTS = { hoursPerDay: 7.5, tolerance: 0.25, absenceIds: ABSENCE_IDS };

let seq = 0;
/** Zeit-Eintrag an einem Tag ("HH:MM"–"HH:MM"). */
function entry(date: string, from: string, to: string, over: Partial<Entry> = {}): Entry {
	return {
		id: `e${seq++}`,
		activityId: PROJEKT,
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
		activityId: URLAUB,
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
			activityId: PROJEKT,
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
		const vorhanden = [entry("2026-01-12", "09:10", "11:00")];
		const plan = planFill(reconcileOne(day(), vorhanden), vorhanden, DEFAULT_FILL_OPTIONS)!;
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
		const vorhanden = [entry("2026-01-12", "09:10", "13:00")];
		const plan = planFill(reconcileOne(day(), vorhanden), vorhanden)!;
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
		const vorhanden = [entry("2026-01-05", "09:00", "12:00")];
		const tag = day({ date: "2026-01-05", firstIn: null, lastOut: null, hours: 7.5 });
		expect(reconcileOne(tag, vorhanden).looksLikeAbsence).toBe(true);
		expect(planFill(reconcileOne(tag, vorhanden), vorhanden)).toBeNull();
	});

	it("schlaegt einen halben freien Tag auch neben Projektzeit vor", () => {
		// Ein halber Urlaubstag darf neben Projektzeit liegen.
		const vorhanden = [entry("2026-01-05", "09:00", "12:00")];
		const tag = day({ date: "2026-01-05", firstIn: null, lastOut: null, hours: 3.75 });
		expect(planFill(reconcileOne(tag, vorhanden), vorhanden)).toMatchObject({
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
		const vorhanden = [absence("2026-01-12")];
		expect(planFill(reconcileOne(day(), vorhanden), vorhanden)).toBeNull();
	});

	it("traegt keine Minutenkrümel an einem Tag nach, der stimmt", () => {
		// 8,55 h laut LOGA gegen 8,50 h erfasst: innerhalb der Toleranz, also
		// „stimmt". Am reinen Vorzeichen der Differenz haengend entstuend hier ein
		// Nachtrag ueber drei Minuten – angehakt und mitgezaehlt.
		const vorhanden = [entry("2026-01-12", "09:02", "17:32")];
		const tag = day({ firstIn: "09:02", lastOut: "18:20", hours: 8.55 });
		const abgleich = reconcileOne(tag, vorhanden);
		expect(abgleich.status).toBe("ok");
		expect(abgleich.diff).toBeGreaterThan(0);
		expect(planFill(abgleich, vorhanden)).toBeNull();
	});

	it("bucht keine zweite Abwesenheit neben einem halben Urlaubstag", () => {
		// Ein halber Tag belegt keine Uhrzeit und wird von der App-Regel nicht
		// abgewiesen – ein ganzer Tag daneben ergaebe still 11,25 h.
		const vorhanden = [absence("2026-01-05", 0.5)];
		const tag = day({ date: "2026-01-05", firstIn: null, lastOut: null, hours: 7.5 });
		const abgleich = reconcileOne(tag, vorhanden);
		expect(abgleich).toMatchObject({ hasAbsence: true, blockedByAbsence: false });
		expect(planFill(abgleich, vorhanden)).toBeNull();
	});

	it("traegt nichts nach, wenn nichts fehlt", () => {
		expect(planFill(reconcileOne(day(), [entry("2026-01-12", "09:10", "16:50")]), [])).toBeNull();
	});

	it("traegt nichts nach, wenn das Fenster voll belegt ist", () => {
		const vorhanden = [entry("2026-01-12", "09:00", "18:00", { activityId: "anderes" })];
		expect(planFill(reconcileOne(day({ hours: 12 }), vorhanden), vorhanden)).toBeNull();
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
	const MIT_ABZUG = { ...OPTS, deductBreaks: true };

	it("rechnet die erfasste Zeit auf derselben Grundlage wie LOGA", () => {
		// Timer lief 08:36–16:49 durch, also 8,22 h brutto. LOGA meldet 7,47 h
		// netto. Ohne Abzug staende der Tag als „zu viel" da, mit Abzug stimmt er.
		const vorhanden = [entry("2026-01-12", "08:36", "16:49")];
		const tag = day({ firstIn: "08:36", lastOut: "16:49", hours: 7.47 });

		expect(reconcile([tag], vorhanden, OPTS).days[0].status).toBe("over");

		const mit = reconcile([tag], vorhanden, MIT_ABZUG).days[0];
		expect(mit.status).toBe("ok");
		expect(mit.tracked).toBeCloseTo(7.47, 2);
		// Die Brutto-Zeit bleibt daneben erhalten.
		expect(mit.workedGross).toBeCloseTo(8.2167, 3);
	});

	it("zieht die Pause nicht von einem Urlaubstag ab", () => {
		const vorhanden = [absence("2026-01-05", 1)];
		const tag = day({ date: "2026-01-05", firstIn: null, lastOut: null, hours: 7.5 });
		expect(reconcile([tag], vorhanden, MIT_ABZUG).days[0]).toMatchObject({
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
		const vorhanden = [entry("2026-01-12", "09:10", "11:00")]; // 1,833 h brutto
		const tag = day({ firstIn: "09:10", lastOut: "17:35", hours: 7.67 });
		const abgleich = reconcile([tag], vorhanden, MIT_ABZUG).days[0];
		const plan = planFill(abgleich, vorhanden, { ...DEFAULT_FILL_OPTIONS, deductBreaks: true })!;
		expect(asClock(plan.blocks)).toEqual(["11:00–17:35"]);
		// Brutto des ganzen Tages danach: 1,833 + 6,583 = 8,417 -> netto 7,67.
		expect(deductBreakFromHours(abgleich.workedGross + plan.hours)).toBeCloseTo(7.67, 2);
	});

	it("spart die Pause weiterhin aus, wenn der Abzug aus ist", () => {
		const plan = planFill(reconcileOne(day()), [], DEFAULT_FILL_OPTIONS)!;
		expect(asClock(plan.blocks)).toEqual(["09:10–12:00", "12:45–17:35"]);
	});
});
