// Abgleich: LOGA-Tagesstunden gegen die hier erfassten Projektzeiten.
//
// Reine Logik, keine Svelte-/Tauri-Abhaengigkeit – die Entscheidung, welcher Tag
// als "fehlt" gilt und wo ein nachgetragener Block liegt, ist der heikle Teil
// und gehoert in Tests.
import type { Entry } from "./types";
import type { TimeReportDay } from "./timeReport";
import { breakHours, grossHours, hasStamps } from "./timeReport";
import { deductBreakFromHours, grossForNet } from "./breaks";
import { entryHours, fmtDate, openEntryUntil, startOfNextDay } from "./time";

/** Zeitspanne innerhalb eines Tages, in Minuten ab Mitternacht. */
export interface Interval {
	start: number;
	end: number;
}

export type ReconcileStatus =
	/** Stunden stimmen im Rahmen der Toleranz */
	| "ok"
	/** LOGA kennt Stunden, hier ist nichts erfasst */
	| "missing"
	/** hier ist weniger erfasst als LOGA kennt */
	| "partial"
	/** hier ist mehr erfasst als LOGA kennt */
	| "over"
	/** LOGA kennt keine Stunden (Wochenende/frei) und hier ist auch nichts erfasst */
	| "free";

export interface ReconcileDay {
	/** "YYYY-MM-DD" */
	date: string;
	report: TimeReportDay;
	/** Erfasste Stunden dieses Tages (Projektzeit + Abwesenheit), nach Pausenabzug */
	tracked: number;
	/** Erfasste Projektzeit dieses Tages VOR dem Pausenabzug, ohne Abwesenheiten */
	workedGross: number;
	/** LOGA minus erfasst; positiv = es fehlt etwas */
	diff: number;
	status: ReconcileStatus;
	/**
	 * Keine Stempel, aber Stunden in Hoehe eines halben oder ganzen Arbeitstags –
	 * in LOGA sieht Urlaub, Feiertag und Gleittag genau so aus. Solche Tage
	 * gehoeren in „Abwesenheiten", nicht auf ein Projekt.
	 */
	looksLikeAbsence: boolean;
	/** Tagesanteil fuer die Abwesenheit (1 oder 0,5), nur wenn looksLikeAbsence */
	absenceFraction: number;
	/** An diesem Tag steht eine Ganztags-Abwesenheit – Projektzeit ist dort gesperrt. */
	blockedByAbsence: boolean;
	/** Irgendeine Abwesenheit (auch ein halber Tag) ist an diesem Tag gebucht. */
	hasAbsence: boolean;
	/** Aus einem Report wurde hier schon einmal nachgetragen. */
	alreadyFilled: boolean;
}

export interface ReconcileOptions {
	/** Stunden eines vollen Arbeitstags (settings.hoursPerDay) */
	hoursPerDay: number;
	/** Ab welcher Abweichung ein Tag auffaellt, in Stunden */
	tolerance: number;
	absenceIds: Set<string>;
	now?: number;
	/**
	 * Pause automatisch abziehen (settings.breakDeduction).
	 *
	 * Ist der Abzug aktiv, rechnet die App auf derselben Grundlage wie LOGA, und
	 * die Spalte „erfasst" ist unmittelbar mit „Arbeitszeit täglich" vergleichbar.
	 * Ohne ihn steht ein durchlaufender Timer dauerhaft als „zu viel" da.
	 */
	deductBreaks?: boolean;
}

export interface ReconcileSummary {
	days: ReconcileDay[];
	ok: number;
	missing: number;
	partial: number;
	over: number;
	/** Summe der fehlenden Stunden ueber alle Tage mit „missing"/„partial" */
	missingHours: number;
}

/** Rundung auf Minuten – 7,469999 h soll nicht als Abweichung durchgehen. */
function roundHours(h: number): number {
	return Math.round(h * 60) / 60;
}

/**
 * Den Report eines Monats gegen die erfassten Eintraege stellen.
 *
 * `days` und `entries` duerfen mehr als den gewuenschten Monat enthalten; das
 * Ergebnis folgt `days`.
 */
export function reconcile(
	days: TimeReportDay[],
	entries: Entry[],
	opts: ReconcileOptions
): ReconcileSummary {
	const now = opts.now ?? Date.now();
	const { hoursPerDay, tolerance, absenceIds } = opts;

	// Erfasste Stunden je Tag; Abwesenheiten mit ihrem Tagesanteil.
	// Projektzeit und Abwesenheit getrennt sammeln: die Pause wird nur von der
	// gearbeiteten Zeit abgezogen, nie von einem Urlaubstag.
	const work = new Map<string, number>();
	const absence = new Map<string, number>();
	const fullDayAbsence = new Set<string>();
	const anyAbsence = new Set<string>();
	const filled = new Set<string>();
	for (const e of entries) {
		const day = fmtDate(e.startTs);
		const isAbsence = absenceIds.has(e.activityId);
		const h = entryHours(e, isAbsence, hoursPerDay, openEntryUntil(e, now));
		if (isAbsence) {
			absence.set(day, (absence.get(day) ?? 0) + h);
			anyAbsence.add(day);
			if ((e.dayFraction ?? 1) >= 1) fullDayAbsence.add(day);
		} else {
			work.set(day, (work.get(day) ?? 0) + h);
		}
		if (e.source === "loga") filled.add(day);
	}

	const tracked = new Map<string, number>();
	for (const day of new Set([...work.keys(), ...absence.keys()])) {
		const worked = work.get(day) ?? 0;
		const netto = opts.deductBreaks ? deductBreakFromHours(worked) : worked;
		tracked.set(day, netto + (absence.get(day) ?? 0));
	}

	const out: ReconcileDay[] = [];
	const summary = { ok: 0, missing: 0, partial: 0, over: 0, missingHours: 0 };

	for (const report of days) {
		const trackedHours = roundHours(tracked.get(report.date) ?? 0);
		const reportHours = roundHours(report.hours);
		const diff = roundHours(reportHours - trackedHours);

		let status: ReconcileStatus;
		if (reportHours <= 0) {
			// Wochenende/frei. Nur auffaellig, wenn hier trotzdem Zeit steht.
			status = trackedHours > tolerance ? "over" : "free";
		} else if (diff > tolerance) {
			status = trackedHours <= tolerance ? "missing" : "partial";
		} else if (diff < -tolerance) {
			status = "over";
		} else {
			status = "ok";
		}

		// Kein Stempel, aber Stunden: Urlaub, Feiertag oder Gleittag. LOGA
		// unterscheidet das nicht – hier ist alles drei „Abwesenheit".
		//
		// Verlangt wird zusaetzlich, dass die Stunden auf einen halben oder ganzen
		// Tag passen. Eine Abwesenheit kennt nur diese beiden Groessen: ein
		// stempelloser 3-Stunden-Tag wuerde sonst als halber Tag gebucht und damit
		// 3,75 h schreiben, wo LOGA 3 h meldet. Solche Tage laufen als normaler
		// Nachtrag mit Uhrzeiten.
		const fullDay = hoursPerDay > 0 && Math.abs(reportHours - hoursPerDay) <= tolerance;
		const halfDay = hoursPerDay > 0 && Math.abs(reportHours - hoursPerDay / 2) <= tolerance;
		const looksLikeAbsence = !hasStamps(report) && reportHours > 0 && (fullDay || halfDay);
		const absenceFraction = fullDay ? 1 : 0.5;

		out.push({
			date: report.date,
			report,
			tracked: trackedHours,
			workedGross: roundHours(work.get(report.date) ?? 0),
			diff,
			status,
			looksLikeAbsence,
			absenceFraction,
			blockedByAbsence: fullDayAbsence.has(report.date),
			hasAbsence: anyAbsence.has(report.date),
			alreadyFilled: filled.has(report.date)
		});

		if (status === "ok") summary.ok++;
		else if (status === "missing") summary.missing++;
		else if (status === "partial") summary.partial++;
		else if (status === "over") summary.over++;
		if (status === "missing" || status === "partial") summary.missingHours += diff;
	}

	return { days: out, ...summary, missingHours: roundHours(summary.missingHours) };
}

// ---------- Nachtrag planen ----------

/** "HH:MM" -> Minuten ab Mitternacht. */
function clockMin(t: string): number {
	const [h, m] = t.split(":").map(Number);
	return h * 60 + m;
}

/**
 * Minuten seit lokaler Mitternacht – aus der WANDUHR, nicht aus der Differenz
 * zum Tagesbeginn.
 *
 * An den beiden Umstellungstagen im Jahr hat ein Tag 23 oder 25 Stunden; eine
 * Differenzrechnung verschoebe dort jede Uhrzeit nach der Umstellung um eine
 * Stunde. Das Fenster kommt aus den Stempeln des Reports und ist Wanduhrzeit –
 * beides muss auf derselben Skala liegen, sonst legte der Nachtrag sich an
 * genau diesen Tagen um eine Stunde versetzt in die Luecken.
 */
function minutesOfDay(ts: number): number {
	const d = new Date(ts);
	return d.getHours() * 60 + d.getMinutes();
}

/** Die von vorhandenen Eintraegen belegten Spannen eines Tages, zusammengefasst. */
export function occupiedIntervals(entries: Entry[], date: string, now: number): Interval[] {
	const raw: Interval[] = [];
	for (const e of entries) {
		if (fmtDate(e.startTs) !== date) continue;
		const end = e.endTs ?? openEntryUntil(e, now);
		// Abwesenheiten sind tagesgenau (start == end) und belegen keine Uhrzeit.
		if (end <= e.startTs) continue;
		// Ueber Mitternacht: an der Tagesgrenze kappen. Genau dort waere die
		// Wanduhrzeit wieder 00:00 – gemeint ist aber das Tagesende.
		const dayEnd = startOfNextDay(e.startTs);
		const stop = Math.min(end, dayEnd);
		raw.push({
			start: minutesOfDay(e.startTs),
			end: stop >= dayEnd ? 1440 : minutesOfDay(stop)
		});
	}
	raw.sort((a, b) => a.start - b.start);

	const merged: Interval[] = [];
	for (const iv of raw) {
		const last = merged[merged.length - 1];
		if (last && iv.start <= last.end) last.end = Math.max(last.end, iv.end);
		else merged.push({ ...iv });
	}
	return merged;
}

/** `window` ohne die belegten Spannen. */
export function freeIntervals(window: Interval, occupied: Interval[]): Interval[] {
	const out: Interval[] = [];
	let cursor = window.start;
	for (const iv of occupied) {
		if (iv.end <= cursor) continue;
		if (iv.start >= window.end) break;
		if (iv.start > cursor) out.push({ start: cursor, end: Math.min(iv.start, window.end) });
		cursor = Math.max(cursor, iv.end);
		if (cursor >= window.end) break;
	}
	if (cursor < window.end) out.push({ start: cursor, end: window.end });
	return out.filter((iv) => iv.end > iv.start);
}

/**
 * Aus den freien Spannen abwechselnd nehmen und ueberspringen.
 * `steps` wird der Reihe nach abgearbeitet, jede Angabe in Minuten.
 */
function carve(free: Interval[], steps: { take: boolean; min: number }[]): Interval[] {
	const out: Interval[] = [];
	let idx = 0;
	let pos = free[0]?.start ?? 0;

	for (const step of steps) {
		let left = step.min;
		while (left > 0 && idx < free.length) {
			const iv = free[idx];
			if (pos < iv.start) pos = iv.start;
			const use = Math.min(iv.end - pos, left);
			if (use > 0) {
				if (step.take) {
					const last = out[out.length - 1];
					// Zwei Stuecke, die exakt aneinander stossen, sind eines.
					if (last && last.end === pos) last.end = pos + use;
					else out.push({ start: pos, end: pos + use });
				}
				pos += use;
				left -= use;
			}
			if (pos >= iv.end) {
				idx++;
				pos = free[idx]?.start ?? 0;
			}
		}
	}
	return out;
}

export interface FillPlan {
	/** "absence" = Abwesenheitstag buchen, "time" = Zeitblöcke anlegen */
	kind: "absence" | "time";
	/** nur bei kind === "absence" */
	fraction: number;
	/** Blöcke INNERHALB der Stempelzeiten; Minuten ab Mitternacht */
	blocks: Interval[];
	/** Summe von `blocks` bzw. der Abwesenheit in Stunden */
	hours: number;
	/**
	 * Blöcke JENSEITS der Stempelzeiten.
	 *
	 * Entstehen, wenn LOGA mehr Stunden meldet, als zwischen „Erstes kommen" und
	 * „Letztes gehen" liegen – die Zeit wurde gebucht, aber nicht gestempelt.
	 * Getrennt ausgewiesen, weil sie meist auf etwas anderes gehört als der
	 * gestempelte Arbeitstag (Dienstreise, Rufbereitschaft, „Others").
	 */
	extraBlocks: Interval[];
	/** Summe von `extraBlocks` in Stunden */
	extraHours: number;
}

export interface FillOptions {
	/** Beginn des Ersatzfensters, wenn keine Stempel vorliegen ("HH:MM") */
	defaultStart: string;
	/** Uhrzeit, an der die Pause bevorzugt liegt ("HH:MM") */
	lunchAt: string;
	now?: number;
	/**
	 * Zieht die App die Pause selbst ab (settings.breakDeduction)?
	 *
	 * Das dreht die Bedeutung des Nachtrags um: dann wird die ANWESENHEIT
	 * eingetragen (also inklusive Pause, wie ein durchlaufender Timer sie
	 * erfasst), und die App zieht sie anschliessend ab. Ohne den Abzug wird die
	 * Pause stattdessen als Luecke ausgespart.
	 */
	deductBreaks?: boolean;
}

export const DEFAULT_FILL_OPTIONS: FillOptions = { defaultStart: "09:00", lunchAt: "12:00" };

/**
 * Wie die fehlende Zeit eines Tages nachgetragen wird.
 *
 * Bei gestempelten Tagen liegt das Fenster zwischen „Erstes kommen" und
 * „Letztes gehen". Ist darin mehr Platz als Stunden fehlen, entsteht eine
 * LUECKE in Hoehe der Pause – sonst stuende der Nachtrag quer durch die
 * Mittagspause, und die Summe waere zwar richtig, der Tag aber erkennbar falsch.
 * Die Luecke wandert an die Mittagszeit, soweit vor und nach ihr noch Arbeit
 * liegt.
 *
 * Belegte Zeiten bleiben unangetastet: `addEntry` weist Ueberschneidungen
 * ohnehin ab, eine Sammeluebernahme scheiterte dort sonst reihenweise.
 *
 * @returns null, wenn nichts nachzutragen ist oder kein Platz bleibt
 */
export function planFill(
	day: ReconcileDay,
	entries: Entry[],
	opts: FillOptions = DEFAULT_FILL_OPTIONS
): FillPlan | null {
	// Nur wo der Abgleich wirklich etwas vermisst. Am reinen Vorzeichen von `diff`
	// zu haengen war falsch: ein Tag mit 8,55 h laut LOGA und 8,50 h erfasst gilt
	// als „stimmt", haette hier aber einen Nachtrag ueber drei Minuten bekommen –
	// angehakt und in der Sammeluebernahme mitgezaehlt.
	if (day.status !== "missing" && day.status !== "partial") return null;
	if (day.diff <= 0) return null;

	const now = opts.now ?? Date.now();
	const occupied = occupiedIntervals(entries, day.date, now);

	if (day.looksLikeAbsence) {
		// Schon eine Abwesenheit am Tag -> nichts zu tun. Auch ein HALBER Tag
		// zaehlt: ein zweiter Eintrag daneben wuerde nicht abgewiesen, sondern
		// stillschweigend doppelt gebucht (7,5 h + 3,75 h = 11,25 h).
		if (day.hasAbsence) return null;
		// Eine GANZTAGS-Abwesenheit und Projektzeit am selben Tag schliessen sich
		// aus (App-Regel); ein halber Tag darf daneben liegen. Ohne diese Wache
		// stuende hier ein Vorschlag, den addEntry beim Uebernehmen abweist – bei
		// einer Sammeluebernahme fuer jeden solchen Tag mit eigener Fehlermeldung.
		if (day.absenceFraction >= 1 && occupied.length > 0) return null;
		return {
			kind: "absence",
			fraction: day.absenceFraction,
			blocks: [],
			hours: day.diff,
			extraBlocks: [],
			extraHours: 0
		};
	}

	// An einem Ganztags-Abwesenheitstag gibt es keine Projektzeit (App-Regel).
	if (day.blockedByAbsence) return null;

	// Zieht die App die Pause selbst ab, ist die Zielgroesse die ANWESENHEIT:
	// LOGA-Stunden sind netto, eins zu eins eingetragen bekaemen sie den Abzug
	// ein zweites Mal und der Tag bliebe dauerhaft zu niedrig.
	const missing = opts.deductBreaks
		? Math.max(0, grossForNet(day.report.hours) - day.workedGross)
		: day.diff;
	const missingMin = Math.round(missing * 60);
	if (missingMin <= 0) return null;

	const pauseMin = Math.round(breakHours(day.report) * 60);

	// Fenster: die Anwesenheit laut Stempeln, sonst ein Ersatzfenster ab
	// defaultStart, das die fehlende Zeit samt Pause fasst.
	let window: Interval;
	// true = das Stempelfenster reicht nicht, es wurde verlaengert.
	let stretched = false;
	// Ende der Stempelzeiten – die Grenze, ab der Nachtrag als „nicht gestempelt"
	// gilt. Ohne Verlaengerung gibt es diese Grenze nicht.
	let stampEnd = Infinity;
	if (hasStamps(day.report)) {
		window = { start: clockMin(day.report.firstIn!), end: clockMin(day.report.lastOut!) };
		if (window.end <= window.start) window.end = 1440; // ueber Mitternacht gestempelt
		// Der Report kann MEHR Stunden melden, als zwischen Kommen und Gehen
		// liegen – dann wurde ausserhalb der Stempelung gearbeitet (nachgebuchte
		// Zeiten, Dienstreise, Korrektur). Im Beispiel: 11:05–16:52 gestempelt,
		// aber 7,37 h gutgeschrieben. Ohne Verlaengerung liesse sich so ein Tag
		// nie vollstaendig nachtragen und bliebe fuer immer als „teilweise" stehen.
		//
		// Bewusst NUR in diesem Fall: ein Rest, der blosss daraus entsteht, dass
		// unsere Pausenregel von LOGAs Abzug abweicht, wird nicht mit erfundener
		// Anwesenheit aufgefuellt.
		if (day.report.hours > grossHours(day.report)) {
			stampEnd = window.end;
			window.end = 1440;
			stretched = true;
		}
	} else {
		const start = clockMin(opts.defaultStart);
		window = { start, end: Math.min(1440, start + missingMin + pauseMin) };
	}

	const free = freeIntervals(window, occupied);
	const freeMin = free.reduce((s, iv) => s + (iv.end - iv.start), 0);
	if (freeMin <= 0) return null;

	const takeMin = Math.min(missingMin, freeMin);
	const slack = freeMin - takeMin;

	let blocks: Interval[];
	// Keine Luecke aussparen, wenn der Abzug sie ohnehin erledigt oder das
	// Fenster ohnehin schon ueber die Stempelzeiten hinaus verlaengert wurde –
	// dort ist von der urspruenglichen Tagesform nichts mehr uebrig.
	if (slack <= 0 || opts.deductBreaks || stretched) {
		blocks = carve(free, [{ take: true, min: takeMin }]);
	} else {
		// Arbeit vor der Mittagspause: so viel freie Zeit, wie vor `lunchAt` liegt.
		const lunch = clockMin(opts.lunchAt);
		const beforeLunch = free.reduce(
			(s, iv) => s + Math.max(0, Math.min(iv.end, lunch) - iv.start),
			0
		);
		const first = Math.min(beforeLunch, takeMin);
		blocks = carve(free, [
			{ take: true, min: first },
			{ take: false, min: slack },
			{ take: true, min: takeMin - first }
		]);
	}

	blocks = blocks.filter((b) => b.end > b.start);
	if (blocks.length === 0) return null;

	// An der Stempelgrenze auftrennen: was dahinter liegt, wurde in LOGA gebucht,
	// aber nicht gestempelt – und gehoert damit meist auf eine andere Aktivitaet.
	const inside: Interval[] = [];
	const extra: Interval[] = [];
	for (const b of blocks) {
		if (b.end <= stampEnd) inside.push(b);
		else if (b.start >= stampEnd) extra.push(b);
		else {
			inside.push({ start: b.start, end: stampEnd });
			extra.push({ start: stampEnd, end: b.end });
		}
	}
	const sum = (list: Interval[]) => list.reduce((acc, b) => acc + (b.end - b.start), 0) / 60;
	return {
		kind: "time",
		fraction: 1,
		blocks: inside,
		hours: sum(inside),
		extraBlocks: extra,
		extraHours: sum(extra)
	};
}
