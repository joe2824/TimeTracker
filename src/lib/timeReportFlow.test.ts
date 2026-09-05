// Durchstich ueber die ganze Kette, gegen die echte Datei:
// XLSX lesen -> Report auswerten -> abgleichen -> Nachtrag planen -> Eintraege
// anlegen -> ERNEUT abgleichen. Danach muss jeder Tag stimmen.
import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { readXlsx } from "./xlsx";
import { grossHours, parseTimeReport, ruleBreakHours, type TimeReportPerson } from "./timeReport";
import {
	DEFAULT_FILL_OPTIONS,
	distributeDays,
	planFill,
	reconcile,
	splitBlocks,
	type Share
} from "./timeReconcile";
import { fmtDate, noonTs, startOfNextDay, toTs } from "./time";
import type { Entry } from "./types";

const HPD = 7.5;
const ABS = "abs";
const PROJ = "proj";
const OTHERS = "others";
const absenceIds = new Set([ABS]);

let person: TimeReportPerson;
let months: string[];

beforeAll(async () => {
	const url = new URL("./testing/timeReport.fixture.xlsx", import.meta.url);
	const report = parseTimeReport(await readXlsx(readFileSync(url)));
	person = report.people[0];
	months = report.months;
});

/** Wie TimeReportImport.svelte: Minute des Tages -> Zeitstempel. */
function tsAt(date: string, minutes: number): number {
	if (minutes >= 1440) return startOfNextDay(noonTs(date));
	const hh = String(Math.floor(minutes / 60)).padStart(2, "0");
	const mm = String(minutes % 60).padStart(2, "0");
	return toTs(date, `${hh}:${mm}`);
}

let uid = 0;

/** Einen Monat vollstaendig nachtragen und das Ergebnis zurueckgeben. */
function fillMonth(month: string, deductBreaks: boolean, shares?: Share[]) {
	const days = person.days.filter((d) => d.date.startsWith(`${month}-`));
	const entries: Entry[] = [];
	const opts = { hoursPerDay: HPD, tolerance: 0.25, absenceIds, deductBreaks };
	const fillOpts = { ...DEFAULT_FILL_OPTIONS, deductBreaks };

	const before = reconcile(days, entries, opts);
	for (const day of before.days) {
		const plan = planFill(day, entries, fillOpts);
		if (!plan) continue;
		if (plan.kind === "absence") {
			const ts = noonTs(day.date);
			entries.push({
				id: `e${uid++}`,
				activityId: ABS,
				startTs: ts,
				endTs: ts,
				note: "",
				source: "loga",
				dayFraction: plan.fraction
			});
		} else {
			// Wie die Oberflaeche: gestempelte Zeit auf das Projekt, die Stunden
			// jenseits der Stempel auf „Others". Mit Verteilung wird die gestempelte
			// Zeit stattdessen in Bloecke je Projekt geschnitten.
			const inside: (readonly [{ start: number; end: number }[], string])[] = shares
				? splitBlocks(plan.blocks, shares).map((p) => [p.blocks, p.id] as const)
				: [[plan.blocks, PROJ] as const];
			for (const [blocks, activityId] of [...inside, [plan.extraBlocks, OTHERS] as const]) {
				for (const b of blocks) {
					entries.push({
						id: `e${uid++}`,
						activityId,
						startTs: tsAt(day.date, b.start),
						endTs: tsAt(day.date, b.end),
						note: "",
						source: "loga"
					});
				}
			}
		}
	}
	return { days, entries, before, after: reconcile(days, entries, opts) };
}

describe.each([true, false])("Durchstich mit Pausenabzug=%s", (deductBreaks) => {
	it("laesst nur Tage offen, an denen LOGA anders abzieht als die Hausregel", () => {
		for (const month of months) {
			const { before, after } = fillMonth(month, deductBreaks);
			// Vorher gab es wirklich etwas zu tun – sonst prueft der Test nichts.
			expect(before.missing + before.partial).toBeGreaterThan(0);

			const unresolved = after.days.filter((d) => d.status !== "ok" && d.status !== "free");
			if (!deductBreaks) {
				// Ohne eigenen Abzug ist die LOGA-Zahl direkt erreichbar.
				expect(unresolved.map((d) => `${d.date} ${d.status}`)).toEqual([]);
				continue;
			}
			// Mit Abzug bleibt ein Rest, wo LOGAs tatsaechlicher Abzug von der
			// Hausregel abweicht – im echten Report rund 11 % der Tage (gestempelte
			// Zusatzpausen, Korrekturbuchungen). Diese Tage sind nicht fuellbar,
			// ohne Anwesenheit zu erfinden; sie bleiben sichtbar stehen.
			for (const d of unresolved) {
				const gross = grossHours(d.report);
				const logaDeduction = gross - d.report.hours;
				expect(Math.abs(logaDeduction - ruleBreakHours(gross))).toBeGreaterThan(0.25);
			}
		}
	});

	it("schlaegt beim zweiten Durchlauf nichts mehr vor", () => {
		// Sonst entstuenden bei jedem Oeffnen des Abgleichs neue Eintraege.
		for (const month of months) {
			const { after, entries } = fillMonth(month, deductBreaks);
			const fillOpts = { ...DEFAULT_FILL_OPTIONS, deductBreaks };
			const again = after.days.filter((d) => planFill(d, entries, fillOpts) !== null);
			expect(again.map((d) => d.date)).toEqual([]);
		}
	});

	it("legt keine sich ueberschneidenden Eintraege an", () => {
		// addEntry wiese solche Eintraege ab – bei einer Sammeluebernahme
		// reihenweise und mit je einer Fehlermeldung.
		for (const month of months) {
			const { entries } = fillMonth(month, deductBreaks);
			expectNoOverlap(entries);
		}
	});

	it("bleibt mit jedem Eintrag innerhalb seines Tages", () => {
		for (const month of months) {
			const { entries } = fillMonth(month, deductBreaks);
			for (const e of entries) {
				expect(e.endTs).not.toBeNull();
				expect(e.endTs!).toBeLessThanOrEqual(startOfNextDay(e.startTs));
				// Abwesenheiten sind tagesgenau (start == end) und haben keine Dauer.
				if (e.activityId === ABS) expect(e.endTs!).toBe(e.startTs);
				else expect(e.endTs!).toBeGreaterThan(e.startTs);
			}
		}
	});

	it("bucht Urlaub und Feiertag als Abwesenheit, nicht als Projektzeit", () => {
		for (const month of months) {
			const { days, entries } = fillMonth(month, deductBreaks);
			// Im Fixture ist jeder stempellose Tag mit Stunden ein voller Tagessatz.
			const free = days.filter((d) => !d.firstIn && d.hours > 0);
			const booked = entries.filter((e) => e.activityId === ABS);
			expect(booked).toHaveLength(free.length);
			for (const e of booked) expect(e.dayFraction).toBe(1);
		}
	});
});

/** Kein Eintrag eines Tages faengt an, bevor der vorige zu Ende ist. */
function expectNoOverlap(entries: Entry[]): void {
	const byDay = new Map<string, Entry[]>();
	for (const e of entries) {
		if (e.activityId === ABS) continue;
		const key = new Date(e.startTs).toDateString();
		(byDay.get(key) ?? byDay.set(key, []).get(key)!).push(e);
	}
	for (const list of byDay.values()) {
		list.sort((a, b) => a.startTs - b.startTs);
		for (let i = 1; i < list.length; i++) {
			expect(list[i].startTs).toBeGreaterThanOrEqual(list[i - 1].endTs!);
		}
	}
}

describe("Nachtrag und Stempelzeiten", () => {
	it("bleibt an gestempelten Tagen zwischen Kommen und Gehen", () => {
		for (const month of months) {
			const { days, entries } = fillMonth(month, true);
			const stamped = new Map(days.filter((d) => d.firstIn && d.lastOut).map((d) => [d.date, d]));
			for (const e of entries) {
				if (e.activityId === ABS) continue;
				const key = fmtDate(e.startTs);
				const day = stamped.get(key);
				if (!day) continue;
				expect(e.startTs).toBeGreaterThanOrEqual(toTs(key, day.firstIn!));
				// Ausnahme: meldet LOGA mehr Stunden, als zwischen Kommen und Gehen
				// liegen, wurde ausserhalb der Stempelung gearbeitet – dort darf der
				// Nachtrag ueber „Letztes gehen" hinausreichen.
				if (day.hours <= grossHours(day)) {
					expect(e.endTs!).toBeLessThanOrEqual(toTs(key, day.lastOut!));
				}
			}
		}
	});

	it("spart die Pause nur ohne eigenen Abzug als Luecke aus", () => {
		// Mit Abzug spannt der Nachtrag die Anwesenheit auf (ein Block je Tag),
		// ohne Abzug entsteht die Mittagsluecke (zwei Bloecke).
		const mit = fillMonth("2026-01", true);
		const ohne = fillMonth("2026-01", false);
		const projects = (r: { entries: Entry[] }) => r.entries.filter((e) => e.activityId === PROJ);
		expect(projects(ohne).length).toBeGreaterThan(projects(mit).length);
	});
});

// Verteilung auf mehrere Projekte: dieselbe Kette, nur dass die gestempelte Zeit
// nicht mehr auf EIN Projekt geht. Der Nachtrag muss danach genauso stimmen –
// beim Schneiden darf keine Minute verloren gehen und keine doppelt zaehlen.
describe("Verteilung auf mehrere Projekte", () => {
	const A = "proj-a";
	const B = "proj-b";
	const SHARES: Share[] = [
		{ id: A, share: 0.6 },
		{ id: B, share: 0.4 }
	];

	it("laesst den Abgleich genauso aufgehen wie ohne Verteilung", () => {
		for (const month of months) {
			const ohne = fillMonth(month, false);
			const mit = fillMonth(month, false, SHARES);
			expect(mit.after.missing + mit.after.partial).toBe(ohne.after.missing + ohne.after.partial);
			expect(mit.after.days.map((d) => d.status)).toEqual(ohne.after.days.map((d) => d.status));
		}
	});

	it("bucht dieselbe Zeit, nur auf zwei Projekte statt eines", () => {
		for (const month of months) {
			const duration = (entries: Entry[], ids: string[]) =>
				entries
					.filter((e) => ids.includes(e.activityId))
					.reduce((s, e) => s + (e.endTs! - e.startTs), 0);
			const ohne = fillMonth(month, false);
			const mit = fillMonth(month, false, SHARES);
			expect(duration(mit.entries, [A, B])).toBe(duration(ohne.entries, [PROJ]));
			// „Others" bleibt unberuehrt: die ungestempelten Stunden werden nicht verteilt.
			expect(duration(mit.entries, [OTHERS])).toBe(duration(ohne.entries, [OTHERS]));
		}
	});

	it("trifft das Verhaeltnis ueber den Monat", () => {
		for (const month of months) {
			const { entries } = fillMonth(month, false, SHARES);
			const ms = (id: string) =>
				entries.filter((e) => e.activityId === id).reduce((s, e) => s + (e.endTs! - e.startTs), 0);
			const fraction = ms(A) / (ms(A) + ms(B));
			// Pro Tag auf die Minute gerundet – ueber einen Monat bleibt davon wenig.
			expect(fraction).toBeCloseTo(0.6, 2);
		}
	});

	it("legt auch verteilt keine sich ueberschneidenden Eintraege an", () => {
		for (const month of months) {
			const { entries } = fillMonth(month, false, SHARES);
			expectNoOverlap(entries);
		}
	});

	it("verteilt tageweise dieselben Stunden, nur ohne Schnitt im Tag", () => {
		for (const month of months) {
			const { days, entries, before } = fillMonth(month, false);
			// Wie die Oberflaeche im Modus „tageweise": ein Projekt je Tag.
			const fillable = before.days
				.filter((d) => planFill(d, [], DEFAULT_FILL_OPTIONS)?.kind === "time")
				.map((d) => ({ date: d.date, hours: planFill(d, [], DEFAULT_FILL_OPTIONS)!.hours }));
			const mapping = distributeDays(fillable, SHARES);
			expect(Object.keys(mapping)).toHaveLength(fillable.length);
			// Jeder Tag geht ganz an eines der beiden Projekte …
			expect(new Set(Object.values(mapping)).size).toBeLessThanOrEqual(2);
			// … und die Summe bleibt die des unverteilten Nachtrags.
			const total = fillable.reduce((s, d) => s + d.hours, 0);
			const proj = entries
				.filter((e) => e.activityId === PROJ)
				.reduce((s, e) => s + (e.endTs! - e.startTs), 0);
			expect(total).toBeCloseTo(proj / 3600000, 6);
			expect(days.length).toBeGreaterThan(0);
		}
	});
});
