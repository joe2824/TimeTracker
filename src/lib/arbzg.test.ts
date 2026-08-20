import { describe, expect, it } from "vitest";
import {
	arbzgMonths,
	AVG_TOLERANCE,
	avgWindow,
	checkArbZg,
	dataFromEntries,
	currentPace,
	dayFacts,
	dayFindings,
	forecast,
	NORM_DAILY
} from "./arbzg";
import { stepDate, toTs } from "./time";
import type { Entry } from "./types";

const ABS = "abs";
const ABSENCE = new Set([ABS]);
const MO_FR = [1, 2, 3, 4, 5];

let seq = 0;
function entry(date: string, from: string, to: string, activityId = "a"): Entry {
	return {
		id: `e${seq++}`,
		activityId,
		startTs: toTs(date, from),
		endTs: toTs(date, to),
		note: "",
		source: "manual"
	};
}

/** Ein Eintrag ab 08:00 ueber `hours` Stunden. */
function day(date: string, hours: number): Entry {
	const end = new Date(toTs(date, "08:00") + hours * 3600000);
	const clock = `${String(end.getHours()).padStart(2, "0")}:${String(end.getMinutes()).padStart(2, "0")}`;
	return entry(date, "08:00", clock);
}

function absence(date: string, fraction = 1): Entry {
	return {
		id: `e${seq++}`,
		activityId: ABS,
		startTs: toTs(date, "12:00"),
		endTs: toTs(date, "12:00"),
		note: "",
		source: "manual",
		dayFraction: fraction
	};
}

/** An jedem Arbeitstag zwischen `from` und `to` je `hours` Stunden. */
function series(from: string, to: string, hours: number, workdays = MO_FR): Entry[] {
	const out: Entry[] = [];
	for (let d = from; d <= to; d = stepDate(d, 1)) {
		if (workdays.includes(new Date(`${d}T12:00:00`).getDay())) out.push(day(d, hours));
	}
	return out;
}

const UNTIL = "2026-06-30";
const HISTORY_FROM = stepDate(UNTIL, -200);
const base = { until: UNTIL, dataFrom: HISTORY_FROM, workdays: MO_FR };

describe("arbzgMonths", () => {
	it("deckt zwoelf Monate bis zum Stichtag ab", () => {
		// 24 Wochen Fenster plus 24 Wochen Vorlauf fuer die Verlaufskurve.
		const m = arbzgMonths("2026-06-30");
		expect(m).toHaveLength(12);
		expect(m[0]).toBe("2025-07");
		expect(m[11]).toBe("2026-06");
	});

	it("rechnet ueber den Jahreswechsel", () => {
		expect(arbzgMonths("2026-01-15")[0]).toBe("2025-02");
	});
});

describe("dataFromEntries", () => {
	it("nimmt den fruehesten erfassten Tag, nicht den Monatsersten", () => {
		// Der Monatserste erfaende hier 26 Werktage mit null Stunden und drueckte
		// den Schnitt genau dort, wo jemand mit dem Erfassen anfaengt.
		expect(dataFromEntries([day("2026-05-14", 8), day("2026-03-27", 8)], "2026-06-30")).toBe(
			"2026-03-27"
		);
	});

	it("faellt ohne Eintraege auf den Stichtag zurueck", () => {
		// Kein Budget aus erfundenen Tagen: ohne Daten ist das Fenster leer, nicht
		// voller Nullen.
		expect(dataFromEntries([], "2026-06-30")).toBe("2026-06-30");
	});
});

describe("dayFacts", () => {
	it("nimmt die Stunden aus derselben Rechnung wie Bericht und Auswertung", () => {
		const f = dayFacts([day("2026-06-10", 8)], ABSENCE, { deductBreaks: true });
		// 8 h brutto minus 45 min Hausregel – wie deductBreakFromHours.
		expect(f.get("2026-06-10")!.hours).toBeCloseTo(7.25);
		const g = dayFacts([day("2026-06-10", 8)], ABSENCE, { deductBreaks: false });
		expect(g.get("2026-06-10")!.hours).toBeCloseTo(8);
	});

	it("laesst Abwesenheiten aus dem Anwesenheitsfenster", () => {
		// Abwesenheiten liegen als Punkt auf der Tagesmitte. Zaehlten sie mit,
		// begaenne der Tag um 12:00 und die Ruhezeit waere frei erfunden.
		const f = dayFacts([absence("2026-06-10", 0.5), day("2026-06-10", 4)], ABSENCE, {});
		const d = f.get("2026-06-10")!;
		expect(d.firstStart).toBe(toTs("2026-06-10", "08:00"));
		expect(d.absenceFraction).toBe(0.5);
	});

	it("kappt mehrere Abwesenheiten am selben Tag bei einem ganzen Tag", () => {
		const f = dayFacts([absence("2026-06-10", 0.5), absence("2026-06-10", 0.5), absence("2026-06-10", 0.5)], ABSENCE, {});
		expect(f.get("2026-06-10")!.absenceFraction).toBe(1);
	});

	it("zaehlt nur Unterbrechungen ab 15 Minuten als Pause", () => {
		// Zwei Luecken von je zehn Minuten sind keine zwanzig Minuten Pause,
		// sondern gar keine – der Block laeuft durch (§ 4 Satz 2).
		const e = [
			entry("2026-06-10", "08:00", "10:00"),
			entry("2026-06-10", "10:10", "12:00"),
			entry("2026-06-10", "12:10", "14:00")
		];
		const d = dayFacts(e, ABSENCE, { deductBreaks: false }).get("2026-06-10")!;
		expect(d.pauseMinutes).toBe(0);
		expect(d.longestStretch).toBeCloseTo(6);
	});

	it("erkennt eine echte Mittagspause", () => {
		const e = [entry("2026-06-10", "08:00", "12:00"), entry("2026-06-10", "12:45", "17:00")];
		const d = dayFacts(e, ABSENCE, { deductBreaks: false }).get("2026-06-10")!;
		expect(d.pauseMinutes).toBe(45);
		expect(d.longestStretch).toBeCloseTo(4.25);
	});

	it("rechnet die Pausen gar nicht erst, wenn der Abzug aktiv ist", () => {
		const d = dayFacts([day("2026-06-10", 8)], ABSENCE, { deductBreaks: true }).get("2026-06-10")!;
		expect(d.pauseMinutes).toBeNull();
		expect(d.longestStretch).toBeNull();
	});
});

describe("avgWindow", () => {
	const facts = () => dayFacts(series(HISTORY_FROM, UNTIL, 7.5), ABSENCE, { deductBreaks: false });

	it("mittelt streng ueber die Arbeitstage", () => {
		const w = avgWindow(facts(), "strict", base);
		// 168 Tage = 24 volle Wochen = 120 Arbeitstage à 7,5 h.
		expect(w.budgetDays).toBe(120);
		expect(w.average).toBeCloseTo(7.5);
		expect(w.complete).toBe(true);
	});

	it("mittelt gesetzlich ueber Mo–Sa und liegt damit deutlich tiefer", () => {
		const w = avgWindow(facts(), "legal", base);
		// 24 * 6 Werktage; der Samstag bringt Budget, aber keine Stunden.
		expect(w.budgetDays).toBe(144);
		expect(w.average).toBeCloseTo((120 * 7.5) / 144);
		// Das ist der Grund fuer die zweite Lesart: hier ist die Grenze weit weg.
		expect(w.bufferHours).toBeGreaterThan(200);
	});

	it("nimmt Abwesenheitstage aus dem Nenner", () => {
		// Sonst liesse sich der Ausgleich erurlauben: ein Urlaubstag bringt kein
		// Acht-Stunden-Budget mit.
		const entries = [...series(HISTORY_FROM, UNTIL, 7.5), absence("2026-06-15"), absence("2026-06-16", 0.5)];
		const w = avgWindow(dayFacts(entries, ABSENCE, { deductBreaks: false }), "strict", base);
		expect(w.budgetDays).toBeCloseTo(120 - 1.5);
	});

	it("meldet eine zu kurze Datenbasis, statt sie mit Null-Tagen aufzufuellen", () => {
		const from = stepDate(UNTIL, -55);
		const w = avgWindow(
			dayFacts(series(from, UNTIL, 7.5), ABSENCE, { deductBreaks: false }),
			"strict",
			{ ...base, dataFrom: from }
		);
		expect(w.complete).toBe(false);
		expect(w.weeksCovered).toBe(8);
		// Der Schnitt bleibt bei 7,5 – erfundene Null-Tage haetten ihn gedrueckt.
		expect(w.average).toBeCloseTo(7.5);
	});

	it("zaehlt Sonntagsstunden im Zaehler, gibt dafuer aber kein Budget", () => {
		const sunday = "2026-06-28"; // Sonntag
		expect(new Date(`${sunday}T12:00:00`).getDay()).toBe(0);
		const plain = avgWindow(facts(), "strict", base);
		const withSunday = avgWindow(
			dayFacts([...series(HISTORY_FROM, UNTIL, 7.5), day(sunday, 6)], ABSENCE, { deductBreaks: false }),
			"strict",
			base
		);
		expect(withSunday.budgetDays).toBe(plain.budgetDays);
		expect(withSunday.actualHours).toBeCloseTo(plain.actualHours + 6);
	});
});

describe("currentPace", () => {
	it("mittelt ueber die Arbeitstage des Bezugszeitraums", () => {
		const facts = dayFacts(series(HISTORY_FROM, UNTIL, 9), ABSENCE, { deductBreaks: false });
		expect(currentPace(facts, base)).toBeCloseTo(9);
	});

	it("laesst sich von Urlaub nicht druecken", () => {
		// Die Frage ist "wie viel arbeite ich an einem Arbeitstag", nicht
		// "wie viel arbeite ich im Kalender".
		const entries = [...series(HISTORY_FROM, UNTIL, 9)].filter(
			(e) => new Date(e.startTs) < new Date(`${stepDate(UNTIL, -10)}T00:00:00`) || new Date(e.startTs) > new Date(`${stepDate(UNTIL, -5)}T23:59:59`)
		);
		for (let d = stepDate(UNTIL, -10); d <= stepDate(UNTIL, -5); d = stepDate(d, 1)) {
			entries.push(absence(d));
		}
		expect(currentPace(dayFacts(entries, ABSENCE, { deductBreaks: false }), base)).toBeCloseTo(9);
	});
});

describe("forecast", () => {
	const facts = (hours: number) =>
		dayFacts(series(HISTORY_FROM, UNTIL, hours), ABSENCE, { deductBreaks: false });

	it("meldet kein Ueberschreiten, wenn das Tempo unter acht Stunden liegt", () => {
		const f = forecast(facts(7.5), "strict", { ...base, pace: 7.5 });
		expect(f.crossing).toBeNull();
		expect(f.peak.average).toBeLessThanOrEqual(NORM_DAILY);
		expect(f.paceDelta).toBeGreaterThan(0);
	});

	it("findet den Tag, an dem der Schnitt bei gleichbleibendem Tempo reisst", () => {
		const f = forecast(facts(7.5), "strict", { ...base, pace: 9.5 });
		expect(f.crossing).not.toBeNull();
		expect(f.crossing!.date > UNTIL).toBe(true);
		// Das Fenster ist erst nach 24 Wochen voll mit den neuen Tagen – vorher
		// haelt die leichtere Vergangenheit den Schnitt unten.
		expect(f.crossing!.date > stepDate(UNTIL, 30)).toBe(true);
	});

	it("liefert das hoechste vertraegliche Tempo exakt", () => {
		// Ist das Fenster irgendwann ganz mit kuenftigen Tagen gefuellt, steht
		// die Antwort fest: streng gerechnet acht Stunden je Arbeitstag,
		// gesetzlich acht mal 144/120 – der Samstag bringt Budget ohne Stunden.
		expect(forecast(facts(7.5), "strict", { ...base, pace: 9.5 }).maxPace).toBeCloseTo(8, 2);
		expect(forecast(facts(7.5), "legal", { ...base, pace: 9.5 }).maxPace).toBeCloseTo(9.6, 2);
	});

	it("haelt mit maxPace, reisst knapp darueber", () => {
		// Der eigentliche Test der Empfehlung: nicht die Zahl, sondern ihre
		// Eigenschaft. Mit dem empfohlenen Tempo bleibt der Schnitt unter acht
		// Stunden, mit einer Viertelstunde mehr je Tag nicht mehr.
		const f = facts(7.5);
		const max = forecast(f, "strict", { ...base, pace: 9.5 }).maxPace!;
		expect(forecast(f, "strict", { ...base, pace: max }).peak.average).toBeLessThanOrEqual(NORM_DAILY + 1e-9);
		expect(forecast(f, "strict", { ...base, pace: max + 0.25 }).crossing).not.toBeNull();
	});

	it("stuft nach Umkehrbarkeit, nicht nach Ueberschreitung", () => {
		// Ueber der Grenze zu liegen ist fuer sich kein Notfall – das Fenster
		// rollt, und wer kuerzer tritt, holt es wieder ein. Gestuft wird deshalb
		// danach, ob es noch zu drehen ist.
		expect(forecast(facts(7.5), "strict", { ...base, pace: 7.5 }).verdict.level).toBe("ok");

		// Laeuft hinein, aber der Umkehrpunkt ist weit: Beobachtung, kein Auftrag.
		const early = forecast(facts(7.5), "strict", { ...base, pace: 9.5 }).verdict;
		expect(early.level).toBe("warn");
		expect(early.requiresAction).toBe(false);
		expect(early.headline).toMatch(/^Umkehrpunkt in/);

		// Umkehrpunkt in Reichweite: jetzt ist etwas zu tun.
		const late = forecast(facts(8), "strict", { ...base, pace: 12 }).verdict;
		expect(late.level).toBe("crit");
		expect(late.requiresAction).toBe(true);
		expect(late.headline).toBe("Jetzt gegensteuern");

		// Schon drueber: kein Prognosefall mehr, sondern der Stand.
		const over = forecast(facts(9), "strict", { ...base, pace: 9 }).verdict;
		expect(over.level).toBe("crit");
		expect(over.headline).toBe("Grenze bereits gerissen");
	});

	it("fordert erst kurz vor dem Umkehrpunkt zum Handeln auf", () => {
		// Der Kern der Beschwerde: bei 8:00 Schnitt und negativem Puffer stand
		// dauerhaft Rot, obwohl noch Wochen Zeit waren, es zu drehen.
		const far = forecast(facts(7.5), "strict", { ...base, pace: 8.3 }).verdict;
		expect(far.headline).toMatch(/Umkehrpunkt in etwa \d+ Wochen/);
		expect(far.requiresAction).toBe(false);

		const near = forecast(facts(8), "strict", { ...base, pace: 10 }).verdict;
		expect(near.headline).toMatch(/^Gegensteuern in \d+ Tagen$/);
		expect(near.requiresAction).toBe(true);
	});

	it("rueckt den Umkehrpunkt naeher, je hoeher das Tempo", () => {
		const f = facts(7.5);
		const slow = forecast(f, "strict", { ...base, pace: 8.3 }).easeOffDate!;
		const fast = forecast(f, "strict", { ...base, pace: 9.5 }).easeOffDate!;
		expect(fast < slow).toBe(true);
	});

	it("zeichnet die Vergangenheit nur so weit, wie ein volles Fenster reicht", () => {
		// Mit 200 Tagen Daten traegt genau der Rest ueber 168 Tage hinaus einen
		// vollstaendigen Rueckblick – mehr darf die Kurve nicht behaupten.
		const past = forecast(facts(7.5), "strict", { ...base, pace: 7.5 }).points.filter((p) => !p.projected);
		expect(past.length).toBeGreaterThan(1);
		expect(past[0].date >= stepDate(HISTORY_FROM, 167)).toBe(true);
	});

	it("faengt erst am Stichtag an, wenn kein volles Fenster in der Vergangenheit liegt", () => {
		// Sonst stuende ein halb ausserhalb der Datenbasis liegendes Fenster als
		// tiefer Punkt in der Kurve und saehe aus wie eine Entspannung, die es
		// nie gab.
		const from = stepDate(UNTIL, -55);
		const f = forecast(
			dayFacts(series(from, UNTIL, 7.5), ABSENCE, { deductBreaks: false }),
			"strict",
			{ ...base, dataFrom: from, pace: 7.5 }
		);
		expect(f.points.filter((p) => !p.projected)).toHaveLength(1);
		expect(f.points[0].date).toBe(UNTIL);
	});

	it("nennt das Entlastungsdatum, wenn die Grenze schon gerissen ist", () => {
		const f = forecast(facts(9.5), "strict", { ...base, pace: 9.5 });
		expect(f.verdict.level).toBe("crit");
		expect(f.verdict.headline).toBe("Grenze bereits gerissen");
		// Ohne jede weitere Stunde faellt der Schnitt erst, wenn die schweren
		// Tage hinten herausgefallen sind – dieser Tag gehoert genannt.
		expect(f.reliefDate).not.toBeNull();
		expect(f.verdict.detail).toContain("ohne jede weitere Stunde");
	});

	it("fragt nicht nach Entlastung, wenn das Fenster traegt", () => {
		expect(forecast(facts(7), "strict", { ...base, pace: 7 }).reliefDate).toBeNull();
	});
});

describe("dayFindings", () => {
	const range = { from: "2026-06-01", to: "2026-06-30" };
	const find = (entries: Entry[], deductBreaks = true) =>
		dayFindings(dayFacts(entries, ABSENCE, { deductBreaks }), { ...range, deductBreaks });

	it("laesst zehn Stunden genau durchgehen und meldet erst darueber", () => {
		expect(find([day("2026-06-10", 10)], false).some((f) => f.rule === "ueber10")).toBe(false);
		const over = find([day("2026-06-10", 10.5)], false);
		expect(over.find((f) => f.rule === "ueber10")?.level).toBe("verstoss");
	});

	it("rechnet die Tagesgrenze auf der Nettozeit, wenn der Abzug aktiv ist", () => {
		// 10:40 h erfasst sind nach Abzug 9:55 h – kein Verstoss. Genau hier zeigt
		// sich, ob die Netto-Basis wirklich durchgezogen ist.
		const f = find([day("2026-06-10", 10 + 40 / 60)]);
		expect(f.some((x) => x.rule === "ueber10")).toBe(false);
		expect(f.some((x) => x.rule === "ueber9_5")).toBe(true);
	});

	it("prueft die Ruhepause nicht, solange der Abzug aktiv ist", () => {
		// Sieben Stunden Timer am Stueck, ohne erfasste Pause. Mit aktivem Abzug
		// rechnet die App wie LOGA – das darf keinen Verstoss ausloesen, sonst
		// waere es der haeufigste Befund und der falscheste.
		const f = find([entry("2026-06-10", "08:00", "15:00")]);
		expect(f.some((x) => x.rule === "ruhepause" || x.rule === "pause6h")).toBe(false);
	});

	it("prueft die Ruhepause, sobald der Abzug aus ist", () => {
		const f = find([entry("2026-06-10", "08:00", "15:00")], false);
		expect(f.find((x) => x.rule === "ruhepause")?.level).toBe("verstoss");
		expect(f.some((x) => x.rule === "pause6h")).toBe(true);
	});

	it("laesst eine ausreichende Pause durchgehen", () => {
		const f = find([entry("2026-06-10", "08:00", "12:00"), entry("2026-06-10", "12:45", "16:00")], false);
		expect(f.some((x) => x.rule === "ruhepause" || x.rule === "pause6h")).toBe(false);
	});

	it("verlangt 45 Minuten jenseits von neun Stunden", () => {
		const f = find([entry("2026-06-10", "07:00", "12:00"), entry("2026-06-10", "12:35", "17:00")], false);
		expect(f.some((x) => x.rule === "ruhepause")).toBe(true);
	});

	it("misst die Ruhezeit zwischen Feierabend und naechstem Beginn", () => {
		const f = find([entry("2026-06-10", "13:00", "22:00"), entry("2026-06-11", "08:30", "12:00")]);
		expect(f.find((x) => x.rule === "ruhezeit")?.level).toBe("verstoss");
	});

	it("laesst elf Stunden genau durchgehen", () => {
		const f = find([entry("2026-06-10", "13:00", "22:00"), entry("2026-06-11", "09:00", "12:00")]);
		expect(f.find((x) => x.rule === "ruhezeit")?.level).toBe("risiko");
	});

	it("misst die Ruhezeit auch ueber die Monatsgrenze", () => {
		const f = dayFindings(
			dayFacts([entry("2026-05-31", "14:00", "23:00"), entry("2026-06-01", "07:00", "12:00")], ABSENCE, {
				deductBreaks: true
			}),
			{ ...range, deductBreaks: true }
		);
		expect(f.find((x) => x.rule === "ruhezeit")?.level).toBe("verstoss");
		// Der Befund gehoert an den Tag, an dem zu frueh angefangen wurde.
		expect(f.find((x) => x.rule === "ruhezeit")?.date).toBe("2026-06-01");
	});

	it("ignoriert einen freien Tag zwischen zwei Arbeitstagen", () => {
		const f = find([entry("2026-06-10", "13:00", "23:00"), entry("2026-06-12", "07:00", "12:00")]);
		expect(f.some((x) => x.rule === "ruhezeit")).toBe(false);
	});

	it("meldet Sonntagsarbeit", () => {
		const f = find([day("2026-06-28", 4)]);
		expect(f.find((x) => x.rule === "sonntag")?.level).toBe("hinweis");
	});
});

describe("checkArbZg", () => {
	it("meldet nur Befunde aus dem Monat des Stichtags", () => {
		const entries = [...series(HISTORY_FROM, UNTIL, 7.5), day("2026-04-14", 11), day("2026-06-16", 11)];
		const r = checkArbZg(entries, {
			...base,
			deductBreaks: false,
			absenceIds: ABSENCE
		});
		const over = r.findings.filter((f) => f.rule === "ueber10");
		expect(over).toHaveLength(1);
		expect(over[0].date).toBe("2026-06-16");
	});

	it("liefert beide Lesarten und eine Empfehlung", () => {
		const r = checkArbZg(series(HISTORY_FROM, UNTIL, 7.5), {
			...base,
			deductBreaks: false,
			absenceIds: ABSENCE
		});
		expect(r.windows.strict.average).toBeCloseTo(7.5);
		expect(r.windows.legal.average).toBeLessThan(r.windows.strict.average);
		expect(r.pace).toBeCloseTo(7.5);
		expect(r.forecasts.strict.verdict.level).toBe("ok");
		expect(r.forecasts.legal.verdict.level).toBe("ok");
	});

	it("meldet einen gerissenen Schnitt im Urteil, nicht als Tagesbefund", () => {
		const r = checkArbZg(series(HISTORY_FROM, UNTIL, 9), {
			...base,
			deductBreaks: false,
			absenceIds: ABSENCE
		});
		// Streng gerissen (9 h), gesetzlich nicht (9 * 120/144 = 7,5).
		expect(r.windows.strict.average).toBeCloseTo(9);
		expect(r.forecasts.strict.verdict.level).toBe("crit");
		expect(r.forecasts.legal.verdict.level).toBe("ok");
		// Er gehoert keinem Tag und darf deshalb in keiner Tageszeile stehen –
		// dort stand er sonst doppelt (je Lesart) am selben Datum, und weil die
		// Liste je Tag nach Regel adressiert wird, war das ein doppelter
		// Schluessel: die Ansicht brach ab, sobald der Schnitt riss.
		const perDay = new Map<string, Set<string>>();
		for (const f of r.findings) {
			const seen = perDay.get(f.date) ?? new Set<string>();
			expect(seen.has(f.rule)).toBe(false); // Regel je Tag eindeutig
			seen.add(f.rule);
			perDay.set(f.date, seen);
		}
	});
});

// ---------------------------------------------------------------------------
// Die Zeitsimulation gegen eine unabhaengige Referenzrechnung.
//
// Die eingesetzte Fassung summiert ueber Praefixsummen: ein Fenster kostet zwei
// Subtraktionen statt 168 Additionen. Genau dort sitzen die Fehler, die keiner
// sieht – ein Tag zu weit links, ein Tag zu weit rechts, ein Budget doppelt
// gezaehlt. Beispieltests fangen so etwas nur zufaellig, weil sie meist glatte
// Zahlen benutzen, bei denen sich ein Versatz aufhebt.
//
// Die Referenz unten ist bewusst NICHT aus der Implementierung abgeleitet,
// sondern aus den dokumentierten Regeln neu aufgeschrieben: Fenster von 168
// Tagen, Tage vor Beginn der Datenbasis tragen nichts, Werktag je nach Lesart,
// Abwesenheit mindert das Budget, kuenftige Arbeitstage bekommen das
// angenommene Tempo.
// ---------------------------------------------------------------------------

/** Deterministischer Zufall – ein fehlschlagender Lauf muss reproduzierbar sein. */
function rng(seed: number): () => number {
	let x = seed >>> 0;
	return () => {
		x = (x * 1664525 + 1013904223) >>> 0;
		return x / 0x100000000;
	};
}

const weekdayOf = (date: string) => new Date(`${date}T12:00:00`).getDay();

/** Der Schnitt eines Fensters, naiv Tag fuer Tag. */
function naiveAverage(opts: {
	facts: Map<string, ReturnType<typeof dayFacts> extends Map<string, infer V> ? V : never>;
	basis: "legal" | "strict";
	end: string;
	until: string;
	dataFrom: string;
	workdays: number[];
	pace: number;
	/** Ab dem Tag DANACH wird nicht mehr gearbeitet. Ohne Angabe: durchgehend. */
	stopAfter?: string;
}): number | null {
	let hours = 0;
	let budget = 0;
	let d = stepDate(opts.end, -167);
	for (let i = 0; i < 168; i++, d = stepDate(d, 1)) {
		if (d < opts.dataFrom) continue; // vor der Datenbasis: traegt nichts bei
		const wd = weekdayOf(d);
		const future = d > opts.until;
		const isWerktag = opts.basis === "legal" ? wd !== 0 : opts.workdays.includes(wd);
		const isPlanWorkday = opts.workdays.includes(wd);
		const absence = future ? 0 : (opts.facts.get(d)?.absenceFraction ?? 0);
		budget += Math.max(0, (isWerktag ? 1 : 0) - absence);
		const worksToday = isPlanWorkday && (opts.stopAfter === undefined || d <= opts.stopAfter);
		hours += future ? (worksToday ? opts.pace : 0) : (opts.facts.get(d)?.hours ?? 0);
	}
	return budget > 0 ? hours / budget : null;
}

/** Ein zufaelliges halbes Jahr: unterschiedlich lange Tage, Urlaub, freie Tage. */
function scenario(seed: number): { entries: Entry[]; dataFrom: string } {
	const rand = rng(seed);
	const entries: Entry[] = [];
	const from = stepDate(UNTIL, -260);
	for (let d = from; d <= UNTIL; d = stepDate(d, 1)) {
		const wd = weekdayOf(d);
		const r = rand();
		if (!MO_FR.includes(wd)) {
			// Gelegentlich Samstagsarbeit – die zaehlt im Zaehler, gibt aber in der
			// strengen Lesart kein Budget.
			if (wd === 6 && r < 0.08) entries.push(day(d, 2 + rand() * 4));
			continue;
		}
		if (r < 0.08) {
			entries.push(absence(d)); // ganzer Urlaubstag
		} else if (r < 0.12) {
			entries.push(absence(d, 0.5));
			entries.push(day(d, 3 + rand() * 2));
		} else if (r < 0.16) {
			// gar nichts erfasst – ein Werktag mit null Stunden
		} else {
			entries.push(day(d, 5 + rand() * 6));
		}
	}
	return { entries, dataFrom: from };
}

describe("Zeitsimulation", () => {
	const flat = (hours: number) =>
		dayFacts(series(HISTORY_FROM, UNTIL, hours), ABSENCE, { deductBreaks: false });

	it("liefert dieselben Fensterschnitte wie eine naive Tag-fuer-Tag-Rechnung", () => {
		for (let seed = 1; seed <= 12; seed++) {
			const { entries, dataFrom } = scenario(seed);
			const facts = dayFacts(entries, ABSENCE, { deductBreaks: false });
			const opts = { until: UNTIL, dataFrom, workdays: MO_FR };
			const pace = currentPace(facts, opts);

			for (const basis of ["legal", "strict"] as const) {
				const f = forecast(facts, basis, { ...opts, pace });
				expect(f.points.length).toBeGreaterThan(10);
				for (const p of f.points) {
					const ref = naiveAverage({ facts, basis, end: p.date, until: UNTIL, dataFrom, workdays: MO_FR, pace });
					expect(
						Math.abs(p.average - (ref ?? 0)),
						`seed ${seed}, ${basis}, ${p.date}: ${p.average} statt ${ref}`
					).toBeLessThan(1e-9);
				}
			}
		}
	});

	it("liefert denselben Stand des Ausgleichsfensters wie die naive Rechnung", () => {
		for (let seed = 20; seed <= 27; seed++) {
			const { entries, dataFrom } = scenario(seed);
			const facts = dayFacts(entries, ABSENCE, { deductBreaks: false });
			const opts = { until: UNTIL, dataFrom, workdays: MO_FR };
			for (const basis of ["legal", "strict"] as const) {
				const w = avgWindow(facts, basis, opts);
				const ref = naiveAverage({ facts, basis, end: UNTIL, until: UNTIL, dataFrom, workdays: MO_FR, pace: 0 });
				expect(Math.abs(w.average - (ref ?? 0)), `seed ${seed}, ${basis}`).toBeLessThan(1e-9);
			}
		}
	});

	it("haelt die Zusage von maxPace – und was sie nicht verspricht", () => {
		// Die Empfehlung lautet "hoechstens X h je Arbeitstag". Zwei Dinge muss sie
		// leisten:
		//
		// 1. Ab vier Wochen Vorlauf haelt sie jedes Fenster unter acht Stunden.
		// 2. Davor darf sie streifen – die Fenster dort sind von bereits
		//    gearbeiteten Stunden bestimmt, und eine Tempoempfehlung kann daran
		//    wenig aendern. Aber sie darf nicht beliebig danebenliegen: eine
		//    Viertelstunde ist die Grenze.
		//
		// Ohne den zweiten Teil waere der erste eine Ausrede – dann duerfte maxPace
		// beliebig zu hoch liegen, solange der Schaden nur frueh genug eintritt.
		const soonEnough = stepDate(UNTIL, 28);
		const NEAR_TERM_SLACK = 0.25;
		let checkedNearTerm = 0;

		for (let seed = 40; seed <= 47; seed++) {
			const { entries, dataFrom } = scenario(seed);
			const facts = dayFacts(entries, ABSENCE, { deductBreaks: false });
			const opts = { until: UNTIL, dataFrom, workdays: MO_FR };
			const f = forecast(facts, "strict", { ...opts, pace: currentPace(facts, opts) });
			if (f.maxPace === null || f.maxPace <= 0) continue;

			const atMax = forecast(facts, "strict", { ...opts, pace: f.maxPace });
			const idle = forecast(facts, "strict", { ...opts, pace: 0 });
			const idleAt = new Map(idle.points.map((p) => [p.date, p.average]));

			for (const p of atMax.points) {
				if (!p.projected) continue;
				if (p.date >= soonEnough) {
					expect(p.average, `seed ${seed}, ${p.date}`).toBeLessThanOrEqual(NORM_DAILY + 1e-9);
				} else {
					expect(p.average, `seed ${seed}, ${p.date} zu weit daneben`).toBeLessThanOrEqual(
						NORM_DAILY + NEAR_TERM_SLACK
					);
					// Und das Fenster darf nie schlechter dastehen als bei Tempo null.
					expect(p.average, `seed ${seed}, ${p.date}`).toBeGreaterThanOrEqual(
						idleAt.get(p.date)! - 1e-9
					);
					checkedNearTerm++;
				}
			}

			// Und die Empfehlung ist nicht unnoetig streng: eine Viertelstunde mehr
			// je Tag reisst es.
			const over = forecast(facts, "strict", { ...opts, pace: f.maxPace + 0.25 });
			expect(over.peak.average, `seed ${seed}`).toBeGreaterThan(NORM_DAILY);
		}
		// Der zweite Teil muss auch wirklich geprueft worden sein.
		expect(checkedNearTerm).toBeGreaterThan(0);
	});

	it("laesst maxPace nicht vom naechsten Tag bestimmen", () => {
		// Der Fehler, der die Kachel „Höchstens" unbrauchbar machte: das Fenster,
		// das MORGEN endet, hat genau einen kuenftigen Arbeitstag im Nenner, und
		// das gesamte Restbudget faellt auf ihn. Bei einem Schnitt knapp unter der
		// Grenze kam so „hoechstens 5:37 h je Arbeitstag" heraus – unter einer
		// Ueberschrift, die sagt, es sei nichts zu tun.
		const f = forecast(flat(7.5), "strict", { ...base, pace: 8.02 });
		expect(f.verdict.requiresAction).toBe(false);
		// Frueher: 5:37 h, bestimmt vom Fenster, das morgen endet.
		expect(f.maxPace!).toBeCloseTo(NORM_DAILY, 6);
	});

	it("faellt beim Tempo auf das volle Fenster zurueck, wenn zuletzt nur Urlaub war", () => {
		// Vier Wochen Urlaub leeren den Nenner des Bezugszeitraums. Ohne
		// Rueckfall waere das Tempo 0:00 und die Auskunft „im gruenen Bereich,
		// Luft 8:00 h je Arbeitstag" – ausgerechnet fuer jemanden, der bei 7:54
		// steht und dessen Fenster sich durch den Urlaub gar nicht entspannt.
		const entries = series(HISTORY_FROM, stepDate(UNTIL, -28), 7.9);
		for (let d = stepDate(UNTIL, -27); d <= UNTIL; d = stepDate(d, 1)) {
			if (MO_FR.includes(weekdayOf(d))) entries.push(absence(d));
		}
		const facts = dayFacts(entries, ABSENCE, { deductBreaks: false });
		const pace = currentPace(facts, { ...base, weeks: 4 });
		// Ohne Rueckfall waere hier 0 herausgekommen.
		expect(pace).toBeGreaterThan(7);
		expect(pace).toBeCloseTo(7.9, 1);
	});

	it("setzt das Entlastungsdatum hinter die LETZTE Ueberschreitung", () => {
		// Nicht auf den ersten Tag unterhalb der Grenze: der kann heute sein,
		// waehrend der Schnitt in vier Wochen noch einmal darueber geht, weil ein
		// leerer Tag hinten aus dem Fenster faellt. Geprueft wird gegen die naive
		// Rechnung ohne jede kuenftige Stunde.
		const limit = NORM_DAILY + AVG_TOLERANCE;
		let checked = 0;

		for (let seed = 80; seed <= 159; seed++) {
			const { entries, dataFrom } = scenario(seed);
			const facts = dayFacts(entries, ABSENCE, { deductBreaks: false });
			const opts = { until: UNTIL, dataFrom, workdays: MO_FR };
			const f = forecast(facts, "strict", { ...opts, pace: 9.5 });
			if (!f.reliefDate) continue;

			// stopAfter = UNTIL heisst: kein einziger kuenftiger Tag wird gearbeitet.
			const idleAt = (end: string) =>
				naiveAverage({ facts, basis: "strict", end, until: UNTIL, dataFrom, workdays: MO_FR, pace: 9.5, stopAfter: UNTIL });

			// Am Tag davor liegt die letzte Ueberschreitung ...
			expect(idleAt(stepDate(f.reliefDate, -1))!, `seed ${seed}`).toBeGreaterThan(limit);
			// ... und ab dem Entlastungsdatum kommt keine mehr.
			let end = f.reliefDate;
			for (let i = 0; end <= stepDate(UNTIL, 26 * 7); i++, end = stepDate(end, 1)) {
				const v = idleAt(end);
				if (v !== null) expect(v, `seed ${seed}, ${end}`).toBeLessThanOrEqual(limit);
			}
			checked++;
		}
		expect(checked).toBeGreaterThan(4);
	});

	it("bestimmt den Umkehrpunkt exakt – am naechsten Arbeitstag traegt es nicht mehr", () => {
		// Der Umkehrpunkt ist per Halbierung gesucht, also genau die Art Zahl, die
		// um eins danebenliegen kann, ohne dass es auffaellt. Geprueft wird er
		// deshalb gegen dieselbe naive Rechnung: bis zum Umkehrpunkt im aktuellen
		// Tempo, danach nichts – dann muss der Hoechststand halten, und am
		// naechsten ARBEITSTAG darf er es nicht mehr. Nicht am naechsten
		// Kalendertag: ein Wochenende weiterzuarbeiten aendert nichts, dort haelt
		// es also zwangslaeufig weiter.
		const limit = NORM_DAILY + AVG_TOLERANCE;
		let checked = 0;

		for (let seed = 60; seed <= 75; seed++) {
			const { entries, dataFrom } = scenario(seed);
			const facts = dayFacts(entries, ABSENCE, { deductBreaks: false });
			const opts = { until: UNTIL, dataFrom, workdays: MO_FR };
			// Ein Tempo deutlich ueber der Grenze erzwingt einen Umkehrpunkt.
			const pace = 9.5;
			const f = forecast(facts, "strict", { ...opts, pace });
			if (!f.easeOffDate || f.tooLate) continue;

			const peakStopping = (stopAfter: string) => {
				let max = 0;
				let end = UNTIL;
				for (let i = 0; i <= 26 * 7; i++, end = stepDate(end, 1)) {
					const v = naiveAverage({ facts, basis: "strict", end, until: UNTIL, dataFrom, workdays: MO_FR, pace, stopAfter });
					if (v !== null && v > max) max = v;
				}
				return max;
			};

			// Der Umkehrpunkt selbst muss ein Arbeitstag sein – sonst ist die
			// Ansage "bis dahin kannst du so weitermachen" nicht wahr.
			expect(MO_FR.includes(weekdayOf(f.easeOffDate)), `seed ${seed}: kein Arbeitstag`).toBe(true);
			expect(peakStopping(f.easeOffDate), `seed ${seed}: Umkehrpunkt traegt nicht`).toBeLessThanOrEqual(limit);

			let next = stepDate(f.easeOffDate, 1);
			while (!MO_FR.includes(weekdayOf(next))) next = stepDate(next, 1);
			expect(
				peakStopping(next),
				`seed ${seed}: auch mit ${next} traegt es noch – der Umkehrpunkt liegt zu frueh`
			).toBeGreaterThan(limit);
			checked++;
		}
		expect(checked).toBeGreaterThan(3);
	});
});
