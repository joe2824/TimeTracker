// Arbeitszeit-Check nach dem Arbeitszeitgesetz (ArbZG).
//
// Der Schwerpunkt liegt auf § 3 Abs. 1 Satz 2: acht Stunden werktaeglich im
// DURCHSCHNITT ueber 24 Wochen. Das ist die Grenze, in die man hineinlaeuft,
// ohne es zu merken – jeder einzelne Tag darf ja bis zu zehn Stunden haben, und
// erst die Summe ueber ein halbes Jahr kippt.
//
// Entscheidend und leicht zu uebersehen: das Fenster ROLLT. Alte schwere Tage
// fallen hinten heraus, waehrend vorne neue hineinlaufen. Der Schnitt steigt
// deshalb nicht monoton, er hat einen Verlauf mit Bergen und Taelern. Eine
// Prognose muss ihn Tag fuer Tag simulieren; eine Hochrechnung "aktueller
// Schnitt plus X" waere schlicht falsch.
//
// Was hier NICHT geprueft wird und warum:
//
// - Ruhepausen (§ 4) nur, wenn der automatische Pausenabzug abgeschaltet ist.
//   Ist er an, rechnet die App wie LOGA und zieht die Pause ohnehin ab – ein
//   Timer, der ueber die Mittagspause durchlaeuft, duerfte dann keinen Verstoss
//   ausloesen. Das waere der haeufigste Befund gewesen, und zwar ein falscher.
// - Feiertage (§ 9), weil die App keinen Feiertagskalender hat. Ein gebuchter
//   Feiertag ist eine Ganztags-Abwesenheit und faellt damit ohnehin aus der
//   Rechnung.
// - Nachtarbeit (§ 6) und Ersatzruhetage (§ 11) – fuer Bueroarbeit totes Gewicht.
//
// Und die Grenze der Datenlage, die jede Ausgabe traegt: erfasst werden
// PROJEKTZEITEN, keine Stempelzeiten. Das Ergebnis ist eine Annahme, kein
// Nachweis; massgeblich bleibt die Zeiterfassung des Arbeitgebers.
import type { Entry } from "./types";
import { dayWorkHours } from "./stats";
import {
	fmtDate,
	fmtDateHuman,
	fmtHoursClock,
	isWorkday,
	monthKey,
	noonTs,
	openEntryUntil,
	stepDate
} from "./time";

/** Werktaegliche Regelarbeitszeit (§ 3 Abs. 1 Satz 1). */
export const NORM_DAILY = 8;
/** Absolute Tagesgrenze (§ 3 Abs. 1 Satz 2) – nicht ausgleichbar. */
export const MAX_DAILY = 10;
/** Ab hier gilt ein Tag als knapp an der 10-h-Grenze. */
export const RISK_DAILY = 9.5;
/** Ununterbrochene Ruhezeit nach Feierabend (§ 5 Abs. 1). */
export const REST_HOURS = 11;
/** Ab hier gilt eine Ruhezeit als knapp. */
export const RISK_REST_HOURS = 11.5;
/**
 * Wie weit der Schnitt ueber acht Stunden liegen muss, damit es als
 * Ueberschreitung gilt – drei Minuten je Werktag.
 *
 * Ohne diese Toleranz wird die Aussage unbrauchbar, sobald die Kurve die
 * Schwelle streift: derselbe Verlauf meldet dann mal "in 6 Tagen", mal "in 12
 * Wochen", je nachdem, an welcher Delle er die 8 zuerst kratzt. Ein Fenster von
 * 120 Werktagen verschiebt schon ein einziger halber Arbeitstag um diese
 * Groessenordnung – eine auf den Tag genaue Prognose gibt die Datenlage dort
 * nicht her, und so eine Zahl zu nennen ist schlimmer als keine.
 */
export const AVG_TOLERANCE = 0.05;
/** Ausgleichszeitraum: 24 Wochen (§ 3 Abs. 1 Satz 2). */
export const AVG_WINDOW_DAYS = 168;
/**
 * Referenzzeitraum, aus dem das "aktuelle Tempo" abgeleitet wird.
 *
 * Zwei Drittel des Ausgleichszeitraums. Bewusst traege: der Umkehrpunkt liegt
 * bei normaler Arbeit Monate voraus, es ist also reichlich Zeit gegenzusteuern,
 * und dann waere ein nervoeser Massstab der falsche. Vier Wochen schlagen schon
 * bei zwei zufaellig langen Wochen aus; auf ein halbes Jahr hochgerechnet wird
 * daraus eine Warnung, die sich von selbst wieder erledigt – und wer die zweimal
 * gesehen hat, sieht die dritte nicht mehr an.
 *
 * Die Kehrseite, offen gesagt: je naeher der Bezugszeitraum an die 24 Wochen
 * rueckt, desto mehr naehert sich das Tempo dem Fensterschnitt SELBST an. Die
 * Prognose wird dadurch flacher und sagt im Grenzfall nur noch "so wie bisher
 * bleibt es, wie es ist" – frueh warnen kann sie dann nicht mehr. Deshalb sind
 * 4, 8 und 12 Wochen in der Karte weiterhin waehlbar; wer den Verdacht hat,
 * gerade laufe eine heisse Phase, sieht dort den ungeglaetteten Stand.
 */
export const DEFAULT_PACE_WEEKS = 16;
/**
 * So viele Arbeitstage muss der Bezugszeitraum mindestens hergeben, sonst wird
 * auf das volle Ausgleichsfenster ausgewichen (siehe currentPace).
 */
export const MIN_PACE_DAYS = 5;
/**
 * So viele kuenftige Arbeitstage muss ein Fenster enthalten, damit es das
 * hoechste vertraegliche Tempo mitbestimmt.
 *
 * Ohne diese Schranke gewinnt immer das Fenster, das morgen endet: dort steht
 * genau EIN kuenftiger Arbeitstag im Nenner, und das gesamte Restbudget des
 * Fensters faellt auf ihn. Bei einem Schnitt von 7:59 kommt so "hoechstens
 * 5:37 h je Arbeitstag" heraus – rechnerisch richtig fuer diesen einen Tag,
 * als Tempo-Empfehlung aber Unsinn. Eine Empfehlung ueber ein Tempo braucht
 * einen Zeitraum, ueber den sie gilt; vier Wochen sind der kuerzeste, der das
 * traegt.
 *
 * Der Preis dafuer, offen gesagt: in den ersten vier Wochen kann der Schnitt
 * die Grenze streifen, obwohl man sich an die Empfehlung haelt – die Fenster
 * dort sind von bereits gearbeiteten Stunden bestimmt. Ueber sechzig zufaellige
 * Halbjahre gemessen lag die groesste Ueberschreitung bei elf Minuten; der Test
 * "haelt die Zusage von maxPace" deckelt sie bei einer Viertelstunde. Ab vier
 * Wochen gilt die Zusage ohne Einschraenkung.
 */
export const MIN_FUTURE_WORKDAYS = 20;
/**
 * So viele Wochen muss die Erfassung abdecken, damit ein Urteil ungefragt
 * angezeigt werden darf.
 *
 * Die Card darf immer rechnen – sie weist die Datenlage aus ("erst 16 von 24
 * Wochen") und wird bewusst aufgesucht. Ein Hinweis, der von sich aus aufpoppt,
 * darf das nicht: aus einem einzigen erfassten Monat mit langen Tagen entstuende
 * sonst ein rotes "Grenze bereits gerissen", das nur heisst, dass die uebrigen
 * fuenf Monate fehlen.
 */
export const MIN_HINT_WEEKS = 8;
/**
 * So viele Tage vor dem Umkehrpunkt wird zum Handeln aufgefordert.
 *
 * Ueber der Grenze zu liegen ist fuer sich genommen kein Notfall: das Fenster
 * rollt, und wer kuerzer tritt, holt es wieder ein. Dringend wird es erst, wenn
 * Kuerzertreten nicht mehr reicht – und davor braucht man Vorlauf, nicht die
 * Meldung selbst.
 */
export const EASE_OFF_LEAD_DAYS = 7;
/** Wie weit die Prognose in die Zukunft rechnet. */
export const DEFAULT_HORIZON_WEEKS = 26;
/** Kuerzeste Unterbrechung, die nach § 4 Satz 2 als Pause zaehlt (Minuten). */
export const MIN_PAUSE_SEGMENT_MIN = 15;
/** Laenger darf nach § 4 Satz 3 nicht am Stueck gearbeitet werden (Stunden). */
export const MAX_STRETCH_HOURS = 6;

/**
 * Welche Tage als "Werktag" in den Nenner des Durchschnitts gehen.
 *
 * - "legal": Montag bis Samstag. So steht es im Gesetz – der Samstag ist ein
 *   Werktag, auch wenn niemand an ihm arbeitet. Bei einer Fuenf-Tage-Woche mit
 *   7,5 h ergibt das rund 250 Stunden Puffer je Fenster; die Grenze ist damit
 *   praktisch unerreichbar, und die Linie laege flach weit unter acht Stunden.
 * - "strict": nur die eingestellten Arbeitstage. Keine Gesetzeslage, sondern
 *   der Fruehwarnwert – nur diese Rechnung warnt frueh genug, um noch etwas
 *   aendern zu koennen. Die Oberflaeche muss beide zeigen und benennen, welche
 *   welche ist.
 */
export type AvgBasis = "legal" | "strict";

export type ArbZgRule =
	| "ueber10"
	| "ueber9_5"
	| "ueber8"
	| "ruhepause"
	| "pause6h"
	| "ruhezeit"
	| "sonntag";

export type ArbZgLevel = "verstoss" | "risiko" | "hinweis";

export interface ArbZgFinding {
	rule: ArbZgRule;
	level: ArbZgLevel;
	/** "YYYY-MM-DD" */
	date: string;
	/** Kurzform fuer ein Badge, z.B. "> 10 h" */
	label: string;
	/** Ein Satz Klartext. */
	text: string;
	/** Gemessener Wert in Stunden, wo einer existiert. */
	value?: number;
	/** Grenzwert in Stunden, gegen den geprueft wurde. */
	limit?: number;
}

/** Was ein einzelner Kalendertag zur Pruefung beitraegt. */
export interface DayFacts {
	/** "YYYY-MM-DD" */
	date: string;
	/** Arbeitszeit in Stunden – netto, wenn der Pausenabzug aktiv ist. */
	hours: number;
	/** Fruehester Beginn einer Projektzeit (Epoch-ms), null ohne Erfassung. */
	firstStart: number | null;
	/** Spaetestes Ende einer Projektzeit (Epoch-ms), null ohne Erfassung. */
	lastEnd: number | null;
	/** Tagesanteil gebuchter Abwesenheit, 0..1. */
	absenceFraction: number;
	/** 0 = Sonntag .. 6 = Samstag */
	weekday: number;
	/**
	 * Summe der Unterbrechungen ab 15 Minuten, in Minuten. Null, wenn der
	 * Pausenabzug aktiv ist – dann wird § 4 nicht geprueft und die Zahl waere
	 * eine Aussage ueber Lueckenhaftigkeit der Erfassung, nicht ueber Pausen.
	 */
	pauseMinutes: number | null;
	/** Laengster Block ohne solche Unterbrechung, in Stunden. Null wie oben. */
	longestStretch: number | null;
}

/** Stand des Ausgleichszeitraums zu einem Stichtag. */
export interface AvgWindow {
	basis: AvgBasis;
	/** Fensteranfang "YYYY-MM-DD" (Stichtag minus 167 Tage). */
	from: string;
	/** Stichtag "YYYY-MM-DD". */
	to: string;
	/** Werktage im Fenster, abzueglich gebuchter Abwesenheiten. */
	budgetDays: number;
	/** budgetDays * 8 */
	budgetHours: number;
	actualHours: number;
	/** actualHours / budgetDays; 0 ohne Budgettage. */
	average: number;
	/** budgetHours - actualHours; negativ = Grenze gerissen. */
	bufferHours: number;
	/** Reicht die Datenbasis ueber das ganze Fenster? */
	complete: boolean;
	/** Tatsaechlich abgedeckte Wochen – nur interessant, wenn !complete. */
	weeksCovered: number;
}

/** Ein Punkt der Verlaufskurve fuer das Diagramm. */
export interface ForecastPoint {
	/** Fensterende "YYYY-MM-DD" */
	date: string;
	average: number;
	/** true = jenseits des Stichtags, also angenommen */
	projected: boolean;
}

export interface Forecast {
	basis: AvgBasis;
	/** Angenommenes Tempo in Stunden je Arbeitstag. */
	pace: number;
	horizonWeeks: number;
	/** Wochenweise abgetastet – fuer das Diagramm, nicht fuer die Entscheidungen. */
	points: ForecastPoint[];
	/** Erster Tag, an dem der Schnitt bei gleichbleibendem Tempo ueber 8 h liegt. */
	crossing: { date: string; average: number } | null;
	/** Hoechststand im Prognosezeitraum. */
	peak: { date: string; average: number };
	/**
	 * Groesstes konstantes Tempo (h je Arbeitstag), mit dem der Schnitt im
	 * ganzen Zeitraum unter acht Stunden bleibt. Null, wenn kein Fenster in der
	 * Zukunft einen Arbeitstag enthaelt (dann laesst sich nichts mehr steuern).
	 */
	maxPace: number | null;
	/** maxPace - pace: negativ = so viel weniger je Tag. */
	paceDelta: number | null;
	/**
	 * Wenn die Grenze schon gerissen ist oder mit maxPace <= 0 nicht mehr zu
	 * halten waere: der Tag, an dem das Fenster auch ohne jede weitere Stunde
	 * wieder unter acht Stunden faellt.
	 */
	reliefDate: string | null;
	/**
	 * Der spaeteste Tag, an dem man anfangen kann herunterzugehen, ohne die
	 * Grenze zu reissen – der Umkehrpunkt.
	 *
	 * Gerechnet wird der guenstigste Fall: bis zu diesem Tag im aktuellen Tempo,
	 * danach gar nichts mehr. Wer spaeter anfaengt, bekommt den Schnitt im
	 * Prognosezeitraum nicht mehr unter acht Stunden.
	 *
	 * Null, wenn es keinen braucht – dann traegt das Fenster das aktuelle Tempo
	 * dauerhaft.
	 */
	easeOffDate: string | null;
	/** Selbst ab sofort nichts mehr zu arbeiten wendet die Ueberschreitung nicht ab. */
	tooLate: boolean;
	/** Kurzurteil fuer den ersten Blick. */
	verdict: Verdict;
}

export type VerdictLevel = "ok" | "warn" | "crit";

/**
 * Das Ergebnis in der Form, in der es gelesen wird: erst die Stufe, dann vier
 * Woerter, dann die eine Zahl, auf die es ankommt.
 *
 * Frueher stand hier ein einzelner langer Satz. Der enthielt alles Noetige und
 * war trotzdem unbrauchbar: drei solche Saetze untereinander sind eine Wand,
 * und die Frage "muss ich etwas tun?" beantwortet keiner davon auf einen Blick.
 */
export interface Verdict {
	level: VerdictLevel;
	/** Kurzurteil, vier bis sechs Woerter. */
	headline: string;
	/** Ein Satz mit der Zahl, die zaehlt. */
	detail: string;
	/**
	 * Ist etwas zu TUN – also muesste man sp&uuml;rbar herunter, um das Fenster zu
	 * halten?
	 *
	 * Getrennt von `level`, weil beides verschiedene Fragen beantwortet. Die Card
	 * darf abgestuft zeigen, dass es eng wird; der Hinweis auf der Tracking-Seite
	 * darf nur dann rufen, wenn Handeln noetig ist. Sonst steht dort dauerhaft
	 * eine Warnung, die nichts von einem will – und dann wird auch die
	 * ueberlesen, die etwas will.
	 */
	requiresAction: boolean;
}

export interface ArbZgOptions {
	/** Stichtag "YYYY-MM-DD" – Ende des Ausgleichsfensters. */
	until: string;
	/** Ab diesem Datum gelten die Eintraege als vollstaendig geladen. */
	dataFrom: string;
	/** Regulaere Arbeitstage als Wochentagsnummern (settings.workdays). */
	workdays: number[];
	/** settings.breakDeduction – schaltet die § 4-Pruefungen. */
	deductBreaks: boolean;
	absenceIds: Set<string>;
	now?: number;
	paceWeeks?: number;
	horizonWeeks?: number;
}

export interface ArbZgResult {
	facts: DayFacts[];
	findings: ArbZgFinding[];
	/** Stand heute, beide Lesarten. */
	windows: { legal: AvgWindow; strict: AvgWindow };
	/** Prognose, beide Lesarten. */
	forecasts: { legal: Forecast; strict: Forecast };
	/** Tempo, auf dem die Prognose beruht (Stunden je Arbeitstag). */
	pace: number;
	counts: Record<ArbZgLevel, number>;
}

// ---------- Datenbeschaffung ----------

/**
 * Die Monate, die fuer einen Stichtag geladen sein muessen.
 *
 * Zwoelf: das Ausgleichsfenster reicht 24 Wochen zurueck, die Verlaufskurve
 * fuer den Rueckblick noch einmal so weit.
 *
 * Steht hier und nicht in der Oberflaeche, weil zwei Ansichten dieselbe Liste
 * brauchen – die Card im Bericht und der Hinweis auf der Tracking-Seite. Zwei
 * Kopien wuerden irgendwann auseinanderlaufen, und die Abweichung faellt
 * niemandem auf: es fehlten einfach still ein paar Wochen im Schnitt.
 */
export function arbzgMonths(until: string): string[] {
	const [y, m] = until.split("-").map(Number);
	const out: string[] = [];
	for (let i = 11; i >= 0; i--) out.push(monthKey(new Date(y, m - 1 - i, 1).getTime()));
	return out;
}

/**
 * Ab wann die Daten als belastbar gelten: der fruehest ERFASSTE Tag.
 *
 * Ein Monat ohne Datei ist von einem Monat ohne Eintraege nicht zu
 * unterscheiden, deshalb faengt die Rechnung erst dort an, wo nachweislich
 * erfasst wurde.
 *
 * Bewusst der Tag und nicht der Monatserste: wer am 20. mit dem Erfassen
 * anfaengt, haette sonst neunzehn erfundene Null-Stunden-Werktage im Nenner.
 * Bei zehn Stunden am Tag drueckt das den Schnitt von 10:00 auf 6:59 – aus
 * einem klaren Verstoss wird eine Beruhigung, und zwar genau in dem Monat, in
 * dem jemand anfaengt hinzusehen.
 */
export function dataFromEntries(entries: Entry[], fallback: string): string {
	let earliest: string | null = null;
	for (const e of entries) {
		const d = fmtDate(e.startTs);
		if (earliest === null || d < earliest) earliest = d;
	}
	return earliest ?? fallback;
}

// ---------- Tagesdaten ----------

/**
 * Die Eintraege zu Tagesdaten verdichten.
 *
 * Die Stunden kommen aus dayWorkHours() – dieselbe Rechnung, die auch Bericht
 * und Auswertung benutzen. Steht hier eine andere Zahl als dort, ist eine von
 * beiden falsch; das darf gar nicht erst moeglich sein.
 */
export function dayFacts(
	entries: Entry[],
	absenceIds: Set<string>,
	opts: { now?: number; deductBreaks?: boolean } = {}
): Map<string, DayFacts> {
	const now = opts.now ?? Date.now();
	const deductBreaks = opts.deductBreaks ?? false;
	const hours = dayWorkHours(entries, absenceIds, now, deductBreaks);

	const out = new Map<string, DayFacts>();
	const spans = new Map<string, { start: number; end: number }[]>();

	const facts = (date: string): DayFacts => {
		let f = out.get(date);
		if (!f) {
			f = {
				date,
				hours: hours.get(date) ?? 0,
				firstStart: null,
				lastEnd: null,
				absenceFraction: 0,
				weekday: new Date(noonTs(date)).getDay(),
				pauseMinutes: null,
				longestStretch: null
			};
			out.set(date, f);
		}
		return f;
	};

	for (const [date] of hours) facts(date);

	for (const e of entries) {
		const date = fmtDate(e.startTs);
		const f = facts(date);
		if (absenceIds.has(e.activityId)) {
			// Mehrere Halbtage am selben Tag ergeben hoechstens einen ganzen.
			f.absenceFraction = Math.min(1, f.absenceFraction + (e.dayFraction ?? 1));
			continue;
		}
		// Abwesenheiten haben start == end == Tagesmitte und wuerden das
		// Anwesenheitsfenster verfaelschen – deshalb erst hier, nach dem continue.
		const end = e.endTs ?? openEntryUntil(e, now);
		if (end <= e.startTs) continue;
		if (f.firstStart === null || e.startTs < f.firstStart) f.firstStart = e.startTs;
		if (f.lastEnd === null || end > f.lastEnd) f.lastEnd = end;
		const list = spans.get(date) ?? [];
		list.push({ start: e.startTs, end });
		spans.set(date, list);
	}

	// Pausen nur, wo sie auch geprueft werden – siehe Kommentar an DayFacts.
	if (!deductBreaks) {
		for (const [date, list] of spans) {
			const f = facts(date);
			const merged = mergeSpans(list);
			let pause = 0;
			let longest = 0;
			for (let i = 0; i < merged.length; i++) {
				longest = Math.max(longest, (merged[i].end - merged[i].start) / 3600000);
				if (i > 0) pause += (merged[i].start - merged[i - 1].end) / 60000;
			}
			f.pauseMinutes = Math.round(pause);
			f.longestStretch = longest;
		}
	}

	return out;
}

/**
 * Spannen sortieren und alles zusammenziehen, was weniger als 15 Minuten
 * auseinanderliegt.
 *
 * Nach § 4 Satz 2 zaehlt eine Unterbrechung erst ab 15 Minuten als Pause. Zwei
 * Luecken von je zehn Minuten sind also keine zwanzig Minuten Pause, sondern
 * gar keine – und der Block dazwischen laeuft fuer § 4 Satz 3 durch.
 */
function mergeSpans(list: { start: number; end: number }[]): { start: number; end: number }[] {
	const sorted = [...list].sort((a, b) => a.start - b.start);
	const out: { start: number; end: number }[] = [];
	for (const s of sorted) {
		const last = out[out.length - 1];
		if (last && s.start - last.end < MIN_PAUSE_SEGMENT_MIN * 60000) {
			last.end = Math.max(last.end, s.end);
		} else {
			out.push({ ...s });
		}
	}
	return out;
}

// ---------- Zeitachse ----------

/**
 * Eine luechenlose Datumsachse von `from` bis `to` mit allem, was die
 * Fensterrechnung braucht.
 *
 * Luechenlos, weil ein Fenster ueber Kalendertage laeuft, nicht ueber erfasste
 * Tage: ein Tag ohne jede Erfassung ist ein Werktag mit null Stunden und
 * gehoert in den Nenner. Wuerde man nur ueber die vorhandenen Tage laufen,
 * saehe ein Monat Urlaub aus wie ein Monat Vollzeit.
 */
interface Axis {
	dates: string[];
	/** Bekannte Stunden; 0 in der Zukunft. */
	hours: number[];
	/** Budgetanteil je Lesart, 0..1. */
	budget: Record<AvgBasis, number[]>;
	/** 1, wenn an diesem kuenftigen Tag nach Plan gearbeitet wird. */
	futureWorkday: number[];
	/** Index des Stichtags. */
	todayIndex: number;
}

function buildAxis(
	facts: Map<string, DayFacts>,
	from: string,
	to: string,
	horizonEnd: string,
	opts: { workdays: number[]; dataFrom: string; until: string }
): Axis {
	const dates: string[] = [];
	for (let d = from; d <= horizonEnd; d = stepDate(d, 1)) dates.push(d);

	const hours: number[] = [];
	const legal: number[] = [];
	const strict: number[] = [];
	const futureWorkday: number[] = [];

	for (const date of dates) {
		const noon = noonTs(date);
		const weekday = new Date(noon).getDay();
		const isPlanWorkday = isWorkday(noon, opts.workdays);
		const future = date > opts.until;
		// Vor dem Beginn der Datenbasis traegt ein Tag NICHTS bei – weder Stunden
		// noch Budget. Sonst verduennten lauter erfundene Null-Tage den Schnitt und
		// die Auskunft waere beruhigend statt richtig.
		const counts = date >= opts.dataFrom;

		const f = facts.get(date);
		hours.push(counts && !future ? (f?.hours ?? 0) : 0);
		futureWorkday.push(future && isPlanWorkday ? 1 : 0);

		if (!counts) {
			legal.push(0);
			strict.push(0);
			continue;
		}
		// Abwesenheit zaehlt nur an ARBEITSTAGEN.
		//
		// Urlaub am Samstag gibt es nicht; report.ts ignoriert Abwesenheiten an
		// Nicht-Arbeitstagen aus demselben Grund ausdruecklich. In der
		// gesetzlichen Lesart ist der Samstag aber ein Werktag – ohne diese Regel
		// hat ein versehentlich dorthin gebuchter Urlaubstag echtes Budget
		// vernichtet und den Schnitt gehoben, ohne dass irgendwo Stunden dazukamen.
		const absence = future || !isPlanWorkday ? 0 : (f?.absenceFraction ?? 0);
		// Sonntag ist kein Werktag; gearbeitete Sonntagsstunden zaehlen trotzdem
		// im Zaehler – die vorsichtige Seite.
		legal.push(Math.max(0, (weekday === 0 ? 0 : 1) - absence));
		strict.push(Math.max(0, (isPlanWorkday ? 1 : 0) - absence));
	}

	return {
		dates,
		hours,
		budget: { legal, strict },
		futureWorkday,
		todayIndex: dates.indexOf(to)
	};
}

/** Prefix-Summen, damit ein Fenster in O(1) statt O(168) summiert wird. */
function prefix(values: number[]): number[] {
	const out = new Array<number>(values.length + 1).fill(0);
	for (let i = 0; i < values.length; i++) out[i + 1] = out[i] + values[i];
	return out;
}

/** Summe ueber [lo, hi] beider Grenzen einschliesslich, geklemmt auf die Achse. */
function range(pre: number[], lo: number, hi: number): number {
	const a = Math.max(0, lo);
	const b = Math.min(pre.length - 2, hi);
	return b < a ? 0 : pre[b + 1] - pre[a];
}

// ---------- Ausgleichszeitraum ----------

/**
 * Stand des 24-Wochen-Fensters zum Stichtag.
 *
 * Abwesenheiten fallen aus dem NENNER, nicht nur aus dem Zaehler: ein
 * Urlaubstag bringt kein Acht-Stunden-Budget mit. Anders gerechnet liesse sich
 * ein Ausgleich schlicht erurlauben, und die Warnung schwiege genau dann, wenn
 * sie gebraucht wird.
 */
export function avgWindow(
	facts: Map<string, DayFacts>,
	basis: AvgBasis,
	opts: { until: string; dataFrom: string; workdays: number[] }
): AvgWindow {
	const from = stepDate(opts.until, -(AVG_WINDOW_DAYS - 1));
	const axis = buildAxis(facts, from, opts.until, opts.until, opts);
	const h = prefix(axis.hours);
	const b = prefix(axis.budget[basis]);

	const actualHours = range(h, 0, axis.todayIndex);
	const budgetDays = range(b, 0, axis.todayIndex);
	const budgetHours = budgetDays * NORM_DAILY;
	const complete = opts.dataFrom <= from;
	const coveredFrom = complete ? from : opts.dataFrom;

	return {
		basis,
		from,
		to: opts.until,
		budgetDays,
		budgetHours,
		actualHours,
		average: budgetDays > 0 ? actualHours / budgetDays : 0,
		bufferHours: budgetHours - actualHours,
		complete,
		weeksCovered: Math.max(0, Math.round(daysBetween(coveredFrom, opts.until) / 7))
	};
}

function daysBetween(a: string, b: string): number {
	const ms = noonTs(b) - noonTs(a);
	return Math.round(ms / 86400000) + 1;
}

/**
 * Das aktuelle Tempo: Stunden je Arbeitstag der letzten `weeks` Wochen.
 *
 * Nenner sind die Arbeitstage abzueglich Abwesenheiten – wer zwei Wochen Urlaub
 * hatte, hat deshalb kein halbiertes Tempo. Die Frage lautet "wie viel arbeite
 * ich an einem Arbeitstag", nicht "wie viel arbeite ich im Kalender".
 *
 * Deckt der Bezugszeitraum zu wenige Arbeitstage ab, wird auf das volle
 * Ausgleichsfenster ausgewichen. Sonst faellt das Tempo nach vier Wochen Urlaub
 * auf null – der Nenner ist dann leer –, und die Prognose meldet ausgerechnet
 * dem, der bei 7:54 steht, "im gruenen Bereich, Luft 8:00 h je Arbeitstag".
 * Ein leerer Nenner ist keine Aussage ueber das Tempo, sondern ihr Fehlen.
 */
export function currentPace(
	facts: Map<string, DayFacts>,
	opts: { until: string; dataFrom: string; workdays: number[]; weeks?: number }
): number {
	const weeks = opts.weeks ?? DEFAULT_PACE_WEEKS;
	const measure = (days: number): { hours: number; budget: number } => {
		const from = stepDate(opts.until, -(days - 1));
		const axis = buildAxis(facts, from, opts.until, opts.until, opts);
		return {
			hours: range(prefix(axis.hours), 0, axis.todayIndex),
			budget: range(prefix(axis.budget.strict), 0, axis.todayIndex)
		};
	};

	let m = measure(weeks * 7);
	if (m.budget < MIN_PACE_DAYS) m = measure(AVG_WINDOW_DAYS);
	return m.budget > 0 ? m.hours / m.budget : 0;
}

// ---------- Prognose ----------

/**
 * Den Verlauf des Schnitts in die Zukunft simulieren.
 *
 * Fuer jedes kuenftige Fensterende E gilt
 *
 *   schnitt(E) = (bekannte Stunden im Fenster + p * kuenftige Arbeitstage)
 *                / Budgettage im Fenster
 *
 * Daraus faellt das hoechste noch vertraegliche Tempo direkt heraus, ohne
 * Suche: aus schnitt(E) <= 8 wird
 *
 *   p <= (8 * Budgettage - bekannte Stunden) / kuenftige Arbeitstage
 *
 * und das Minimum ueber alle E ist die Antwort. Ein Fenster ohne kuenftige
 * Arbeitstage laesst sich durch kein p mehr beeinflussen – so eines ist
 * entweder schon gerissen oder unkritisch, und das wird getrennt gemeldet.
 */
export function forecast(
	facts: Map<string, DayFacts>,
	basis: AvgBasis,
	opts: {
		until: string;
		dataFrom: string;
		workdays: number[];
		pace: number;
		horizonWeeks?: number;
	}
): Forecast {
	const horizonWeeks = opts.horizonWeeks ?? DEFAULT_HORIZON_WEEKS;
	// Doppelt so weit zurueck wie das Fenster lang ist: ein Fenster, das VOR dem
	// Stichtag endet, braucht seinerseits 168 Tage Vorlauf. Nur so laesst sich
	// zeichnen, wo der Schnitt hergekommen ist.
	const from = stepDate(opts.until, -(2 * AVG_WINDOW_DAYS - 1));
	const horizonEnd = stepDate(opts.until, horizonWeeks * 7);
	const axis = buildAxis(facts, from, opts.until, horizonEnd, opts);
	const h = prefix(axis.hours);
	const b = prefix(axis.budget[basis]);
	const w = prefix(axis.futureWorkday);

	const at = (i: number, pace: number) => {
		const lo = i - (AVG_WINDOW_DAYS - 1);
		const budget = range(b, lo, i);
		if (budget <= 0) return null;
		return (range(h, lo, i) + pace * range(w, lo, i)) / budget;
	};

	const points: ForecastPoint[] = [];
	let crossing: Forecast["crossing"] = null;
	let peak = { date: opts.until, average: at(axis.todayIndex, opts.pace) ?? 0 };
	let maxPace: number | null = null;

	// Gezeichnet wird nur ruecklaeufig, soweit die Daten ein VOLLES Fenster
	// hergeben. Ein Fenster, das zur Haelfte vor dem ersten erfassten Tag liegt,
	// stuende sonst als tiefer Punkt in der Kurve und saehe aus wie eine
	// Entspannung, die es nie gab.
	const dataFromIndex = Math.max(0, axis.dates.indexOf(opts.dataFrom));
	const firstFullWindow = Math.max(dataFromIndex, 0) + AVG_WINDOW_DAYS - 1;
	const startIndex = Math.min(
		axis.todayIndex,
		Math.max(firstFullWindow, axis.todayIndex - AVG_WINDOW_DAYS)
	);

	for (let i = startIndex; i < axis.dates.length; i++) {
		const date = axis.dates[i];
		const avg = at(i, opts.pace);
		if (avg === null) continue;

		const sampled = (i - axis.todayIndex) % 7 === 0;
		if (sampled || i === startIndex || i === axis.dates.length - 1) {
			points.push({ date, average: avg, projected: i > axis.todayIndex });
		}

		// Entschieden wird ausschliesslich ab dem Stichtag – die Vergangenheit
		// ist Kulisse, kein Befund.
		if (i < axis.todayIndex) continue;

		if (avg > peak.average) peak = { date, average: avg };
		if (crossing === null && avg > NORM_DAILY + AVG_TOLERANCE && i > axis.todayIndex) {
			crossing = { date, average: avg };
		}

		// Hoechstes vertraegliches Tempo aus genau diesem Fenster.
		const lo = i - (AVG_WINDOW_DAYS - 1);
		const futureDays = range(w, lo, i);
		if (futureDays >= MIN_FUTURE_WORKDAYS) {
			const limit = (NORM_DAILY * range(b, lo, i) - range(h, lo, i)) / futureDays;
			maxPace = maxPace === null ? limit : Math.min(maxPace, limit);
		}

		// Entlastung: ab wann traegt das Fenster wieder, selbst ohne jede weitere
		// Stunde? Nur diese Frage bleibt, wenn maxPace ins Negative faellt.
	}

	/**
	 * Der Schnitt eines Fensters, wenn nur bis `stopIndex` im aktuellen Tempo
	 * gearbeitet wird und danach gar nicht mehr.
	 *
	 * Kein Neuaufbau der Summen noetig: `w` zaehlt die kuenftigen Arbeitstage,
	 * und es genuegt, den Zaehlbereich am Aufhoertag abzuschneiden.
	 */
	const atWithStop = (i: number, stopIndex: number): number | null => {
		const lo = i - (AVG_WINDOW_DAYS - 1);
		const budget = range(b, lo, i);
		if (budget <= 0) return null;
		return (range(h, lo, i) + opts.pace * range(w, lo, Math.min(i, stopIndex))) / budget;
	};

	/** Hoechststand im Prognosezeitraum, wenn ab `stopIndex + 1` nichts mehr kommt. */
	const peakWithStop = (stopIndex: number): number => {
		let max = 0;
		for (let i = axis.todayIndex; i < axis.dates.length; i++) {
			const v = atWithStop(i, stopIndex);
			if (v !== null && v > max) max = v;
		}
		return max;
	};

	// Je spaeter der Aufhoertag, desto mehr lange Tage im Fenster – der
	// Hoechststand waechst also monoton mit `stopIndex`. Damit findet die
	// Halbierung den letzten Tag, der noch traegt, in acht Schritten.
	const holds = (stopIndex: number) => peakWithStop(stopIndex) <= NORM_DAILY + AVG_TOLERANCE;
	const last = axis.dates.length - 1;
	let easeOffDate: string | null = null;
	const tooLate = !holds(axis.todayIndex - 1);
	if (!tooLate && !holds(last)) {
		let lo = axis.todayIndex - 1; // haelt
		let hi = last; // haelt nicht
		while (hi - lo > 1) {
			const mid = Math.floor((lo + hi) / 2);
			if (holds(mid)) lo = mid;
			else hi = mid;
		}
		// Auf den letzten ARBEITSTAG zurueckgehen.
		//
		// Die Halbierung liefert den letzten Kalendertag, der noch traegt – und der
		// faellt gern auf einen Sonntag, weil ein arbeitsfreier Tag am Ergebnis
		// nichts aendert und deshalb genauso "haelt" wie der Freitag davor. Als
		// Ansage taugt das nicht: "bis Sonntag kannst du so weitermachen" heisst
		// in Wahrheit "bis Freitag". Gemeint ist der letzte Tag, an dem noch
		// gearbeitet wird, also wird bis dorthin zurueckgegangen.
		let i = Math.max(axis.todayIndex, lo);
		while (i > axis.todayIndex && !isWorkday(noonTs(axis.dates[i]), opts.workdays)) i--;
		easeOffDate = axis.dates[i];
	}

	/**
	 * Ab wann traegt das Fenster wieder, selbst ohne jede weitere Stunde?
	 *
	 * Gefragt ist der Tag NACH der letzten Ueberschreitung, nicht der erste Tag
	 * unterhalb der Grenze: der kann heute sein, waehrend der Schnitt in vier
	 * Wochen noch einmal darueber geht, weil ein leerer Tag hinten aus dem
	 * Fenster faellt.
	 *
	 * Gerechnet wird gegen dieselbe Schwelle wie das Urteil. Vorher stand hier
	 * die nackte Acht: bei einem Schnitt zwischen 8:00 und 8:03 entstand dadurch
	 * ein Datum, das keine Stufe je benutzte, und im Fall "nicht mehr
	 * aufzuhalten" fehlte es umgekehrt genau dann, wenn der Schnitt heute noch
	 * unter der Toleranz lag.
	 */
	const limit = NORM_DAILY + AVG_TOLERANCE;
	let lastOver = -1;
	for (let i = axis.todayIndex; i < axis.dates.length; i++) {
		const idle = at(i, 0);
		if (idle !== null && idle > limit) lastOver = i;
	}
	const reliefDate =
		lastOver >= 0 && lastOver + 1 < axis.dates.length ? axis.dates[lastOver + 1] : null;

	const paceDelta = maxPace === null ? null : maxPace - opts.pace;

	return {
		basis,
		pace: opts.pace,
		horizonWeeks,
		points,
		crossing,
		peak,
		maxPace,
		paceDelta,
		reliefDate,
		easeOffDate,
		tooLate,
		verdict: makeVerdict({
			until: opts.until,
			pace: opts.pace,
			easeOffDate,
			tooLate,
			currentAverage: at(axis.todayIndex, 0) ?? 0,
			crossing,
			peak,
			maxPace,
			paceDelta,
			reliefDate
		})
	};
}

/**
 * Aus der Rechnung ein Urteil machen.
 *
 * Dringlichkeit bemisst sich an der UMKEHRBARKEIT, nicht daran, ob die Grenze
 * gerade ueberschritten ist. Ein paar Minuten ueber acht Stunden sind kein
 * Notfall – das Fenster rollt, und wer kuerzer tritt, holt es wieder ein. Ernst
 * wird es, wenn Kuerzertreten nicht mehr reicht. Deshalb steuert der
 * Umkehrpunkt die Stufen und nicht der aktuelle Schnitt: gewarnt wird eine Woche
 * vorher, nicht monatelang davor.
 */
function makeVerdict(f: {
	until: string;
	pace: number;
	currentAverage: number;
	easeOffDate: string | null;
	tooLate: boolean;
	crossing: Forecast["crossing"];
	peak: { date: string; average: number };
	maxPace: number | null;
	paceDelta: number | null;
	reliefDate: string | null;
}): Verdict {
	const de = (iso: string) => fmtDateHuman(noonTs(iso));
	const h = (v: number) => `${fmtHoursClock(v)} h`;
	const ceiling =
		f.maxPace !== null && f.maxPace > 0 ? ` Nötig wären höchstens ${h(f.maxPace)} je Arbeitstag.` : "";

	// Schon drueber – das ist keine Prognose mehr, sondern der Stand.
	if (f.currentAverage > NORM_DAILY + AVG_TOLERANCE) {
		return {
			level: "crit",
			requiresAction: true,
			headline: "Grenze bereits gerissen",
			detail: f.reliefDate
				? `Der Schnitt liegt bei ${h(f.currentAverage)}. Auch ohne jede weitere Stunde fällt er erst am ${de(f.reliefDate)} wieder unter ${h(NORM_DAILY)}.`
				: `Der Schnitt liegt bei ${h(f.currentAverage)} und damit über den erlaubten ${h(NORM_DAILY)}.`
		};
	}

	// Der Umkehrpunkt ist bereits verstrichen.
	if (f.tooLate) {
		return {
			level: "crit",
			requiresAction: true,
			headline: "Nicht mehr aufzuhalten",
			detail: f.reliefDate
				? `Selbst wenn du ab sofort gar nicht mehr arbeitest, geht der Schnitt über ${h(NORM_DAILY)}; entlastet ist das Fenster erst am ${de(f.reliefDate)}.`
				: `Selbst ohne jede weitere Stunde geht der Schnitt über ${h(NORM_DAILY)}.`
		};
	}

	if (f.easeOffDate) {
		const days = Math.max(0, daysBetween(f.until, f.easeOffDate) - 1);

		// Der Umkehrpunkt rueckt in Reichweite: jetzt ist etwas zu tun.
		if (days <= EASE_OFF_LEAD_DAYS) {
			return {
				level: "crit",
				requiresAction: true,
				headline: days <= 1 ? "Jetzt gegensteuern" : `Gegensteuern in ${days} Tagen`,
				detail:
					`Bis ${de(f.easeOffDate)} kannst du dein Tempo von ${h(f.pace)} noch drehen. Wer später anfängt, bekommt den Schnitt im Prognosezeitraum nicht mehr unter ${h(NORM_DAILY)}.` +
					ceiling
			};
		}

		// Noch Zeit: eine Beobachtung, keine Aufforderung.
		const weeks = Math.round(days / 7);
		return {
			level: "warn",
			requiresAction: false,
			headline: days <= 14 ? `Umkehrpunkt in ${days} Tagen` : `Umkehrpunkt in etwa ${weeks} Wochen`,
			detail: `Mit ${h(f.pace)} je Arbeitstag kannst du bis ${de(f.easeOffDate)} so weitermachen; bis dahin ist es umkehrbar.${ceiling}`
		};
	}

	// Kein Umkehrpunkt noetig – das Tempo traegt das Fenster dauerhaft.
	if (f.peak.average > NORM_DAILY - AVG_TOLERANCE) {
		return {
			level: "warn",
			requiresAction: false,
			headline: "Dicht an der Grenze",
			detail: `Höchststand ${h(f.peak.average)} am ${de(f.peak.date)} – so nah an ${h(NORM_DAILY)}, dass schon ein einzelner langer Tag den Ausschlag gibt.`
		};
	}

	return {
		level: "ok",
		requiresAction: false,
		headline: "Im grünen Bereich",
		detail:
			f.paceDelta !== null && f.paceDelta > 0
				? `Höchststand ${h(f.peak.average)} am ${de(f.peak.date)}. Luft bis zur Grenze: ${h(f.paceDelta)} je Arbeitstag.`
				: `Höchststand ${h(f.peak.average)} am ${de(f.peak.date)}.`
	};
}

// ---------- Tagesbefunde ----------


/**
 * Die Tagesregeln pruefen.
 *
 * `deductBreaks` schaltet § 4 ab – die Begruendung steht im Dateikopf.
 */
export function dayFindings(
	facts: Map<string, DayFacts>,
	opts: { from: string; to: string; deductBreaks: boolean }
): ArbZgFinding[] {
	const out: ArbZgFinding[] = [];
	const dates = [...facts.keys()].sort();

	// Fuer § 5 zaehlt das Ende des letzten Tages, an dem ueberhaupt erfasst
	// wurde – nicht das des Vortags. Nach einem freien Tag ist die Ruhezeit
	// laengst erfuellt, die Rechnung ergibt dann von selbst einen grossen Wert.
	let prevEnd: number | null = null;

	for (const date of dates) {
		const f = facts.get(date)!;
		const inRange = date >= opts.from && date <= opts.to;
		const add = (rule: ArbZgRule, level: ArbZgLevel, label: string, text: string, value?: number, limit?: number) => {
			if (inRange) out.push({ rule, level, date, label, text, value, limit });
		};

		if (f.hours > 0) {
			if (f.hours > MAX_DAILY) {
				add("ueber10", "verstoss", "> 10 h",
					`${fmtHoursClock(f.hours)} h Arbeitszeit – über der absoluten Tagesgrenze von 10 h. Das lässt sich nicht über den Durchschnitt ausgleichen.`,
					f.hours, MAX_DAILY);
			} else if (f.hours > RISK_DAILY) {
				add("ueber9_5", "risiko", "≈ 10 h",
					`${fmtHoursClock(f.hours)} h Arbeitszeit – knapp unter der Tagesgrenze von 10 h.`,
					f.hours, MAX_DAILY);
			} else if (f.hours > NORM_DAILY) {
				add("ueber8", "hinweis", "> 8 h",
					`${fmtHoursClock(f.hours)} h Arbeitszeit – zulässig, muss aber im 24-Wochen-Schnitt ausgeglichen werden.`,
					f.hours, NORM_DAILY);
			}

			if (f.weekday === 0) {
				add("sonntag", "hinweis", "Sonntag",
					`${fmtHoursClock(f.hours)} h an einem Sonntag – Sonntagsarbeit ist nur in Ausnahmefällen zulässig.`,
					f.hours);
			}

			if (!opts.deductBreaks) {
				const pause = f.pauseMinutes ?? 0;
				const required = f.hours > 9 ? 45 : f.hours > 6 ? 30 : 0;
				if (required > 0 && pause < required) {
					add("ruhepause", "verstoss", "Ruhepause",
						`${fmtHoursClock(f.hours)} h Arbeitszeit bei ${pause} min Pause – erforderlich sind ${required} min.`,
						pause / 60, required / 60);
				}
				if ((f.longestStretch ?? 0) > MAX_STRETCH_HOURS) {
					add("pause6h", "verstoss", "6 h am Stück",
						`${fmtHoursClock(f.longestStretch ?? 0)} h ohne Unterbrechung von mindestens 15 Minuten – nach 6 h muss eine Pause liegen.`,
						f.longestStretch ?? 0, MAX_STRETCH_HOURS);
				}
			}
		}

		if (f.firstStart !== null && prevEnd !== null && f.firstStart > prevEnd) {
			const rest = (f.firstStart - prevEnd) / 3600000;
			if (rest < REST_HOURS) {
				add("ruhezeit", "verstoss", "Ruhezeit",
					`Nur ${fmtHoursClock(rest)} h zwischen Feierabend am Vortag und Arbeitsbeginn – vorgeschrieben sind 11 h.`,
					rest, REST_HOURS);
			} else if (rest < RISK_REST_HOURS) {
				add("ruhezeit", "risiko", "Ruhezeit knapp",
					`${fmtHoursClock(rest)} h Ruhezeit – knapp über den vorgeschriebenen 11 h.`,
					rest, REST_HOURS);
			}
		}
		if (f.lastEnd !== null) prevEnd = f.lastEnd;
	}

	return out;
}

// ---------- Gesamtergebnis ----------

/**
 * Der komplette Check fuer die Oberflaeche.
 *
 * `entries` darf ruhig mehr als den betrachteten Monat enthalten – fuer das
 * Ausgleichsfenster MUSS es das sogar, sonst steht `complete` auf false und die
 * Prognose ist nur ein Anhaltspunkt.
 */
export function checkArbZg(entries: Entry[], opts: ArbZgOptions): ArbZgResult {
	const facts = dayFacts(entries, opts.absenceIds, {
		now: opts.now,
		deductBreaks: opts.deductBreaks
	});

	const base = { until: opts.until, dataFrom: opts.dataFrom, workdays: opts.workdays };
	const pace = currentPace(facts, { ...base, weeks: opts.paceWeeks });

	const findings = dayFindings(facts, {
		from: opts.until.slice(0, 7) + "-01",
		to: opts.until,
		deductBreaks: opts.deductBreaks
	});

	// Der gerissene Durchschnitt ist bewusst KEIN Tagesbefund. Er gehoert keinem
	// Tag – er faellt am Stichtag an und galt genauso am Tag davor. Als Zeile in
	// "Auffaellige Tage" stand er doppelt (einmal je Lesart) am selben Datum, und
	// weil die Liste nach Regel adressiert wird, war das ausserdem ein doppelter
	// Schluessel. Sichtbar ist er da, wo er hingehoert: im Urteil ganz oben.
	const windows = {
		legal: avgWindow(facts, "legal", base),
		strict: avgWindow(facts, "strict", base)
	};

	const forecastOpts = { ...base, pace, horizonWeeks: opts.horizonWeeks };
	const forecasts = {
		legal: forecast(facts, "legal", forecastOpts),
		strict: forecast(facts, "strict", forecastOpts)
	};

	const counts: Record<ArbZgLevel, number> = { verstoss: 0, risiko: 0, hinweis: 0 };
	for (const f of findings) counts[f.level]++;

	return {
		facts: [...facts.values()].sort((a, b) => a.date.localeCompare(b.date)),
		findings,
		windows,
		forecasts,
		pace,
		counts
	};
}
