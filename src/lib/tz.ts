/**
 * Zeitzonen-Grundrechnung.
 *
 * Bis hierher rechnete alles mit den lokalen Date-Methoden, der Arbeitstag war
 * also implizit der des Geraets. Sobald dieselben Daten von zwei Geraeten kommen
 * (Handy auf Reisen, Rechner daheim), zerfaellt das: derselbe Zeitstempel landet
 * je nach Geraet an einem anderen Kalendertag, und damit in einer anderen
 * Monatsdatei, einer anderen Tagessumme und einem anderen Bericht.
 *
 * Deshalb gibt es genau EINE Zeitzone je Konto (`Settings.timeZone`), gegen die
 * alle Tagesgrenzen gerechnet werden. Dieses Modul ist ihre einzige Quelle.
 *
 * Die Zeitstempel selbst bleiben unveraendert Epoch-Millisekunden, also UTC –
 * gerechnet wird nur die Frage "welcher Kalendertag ist das".
 */

/** Die Zeitzone, wenn keine gesetzt ist oder die gesetzte unbrauchbar wurde. */
const FALLBACK_ZONE = "UTC";

/**
 * Die Zeitzone des Geraets. Vorbelegung beim ersten Start.
 *
 * Faellt auf UTC zurueck, wenn die Laufzeit keine liefert – lieber eine
 * nachvollziehbare feste Zone als eine, die von Start zu Start wechselt.
 */
export function systemTimeZone(): string {
	try {
		return Intl.DateTimeFormat().resolvedOptions().timeZone || FALLBACK_ZONE;
	} catch {
		return FALLBACK_ZONE;
	}
}

export function isValidTimeZone(tz: string): boolean {
	if (!tz) return false;
	try {
		new Intl.DateTimeFormat("en-US", { timeZone: tz });
		return true;
	} catch {
		return false;
	}
}

let currentZone = systemTimeZone();

/** Die Zeitzone, gegen die alle Tagesgrenzen gerechnet werden. */
export function appTimeZone(): string {
	return currentZone;
}

/**
 * Die Zeitzone setzen. Eine unbekannte Kennung wird abgewiesen und die bisherige
 * behalten – eine kaputte Zone wuerde sonst jede Datumsrechnung der App kippen.
 *
 * @returns ob die Zone uebernommen wurde
 */
export function setAppTimeZone(tz: string): boolean {
	if (!isValidTimeZone(tz)) return false;
	if (tz !== currentZone) {
		currentZone = tz;
		offsetCache.clear();
	}
	return true;
}

// ---- Umrechnung ----

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(tz: string): Intl.DateTimeFormat {
	let f = formatters.get(tz);
	if (!f) {
		f = new Intl.DateTimeFormat("en-US", {
			timeZone: tz,
			hourCycle: "h23",
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
			hour: "2-digit",
			minute: "2-digit",
			second: "2-digit"
		});
		formatters.set(tz, f);
	}
	return f;
}

export interface ZonedParts {
	year: number;
	month: number;
	/** 1–31 */
	day: number;
	hour: number;
	minute: number;
	second: number;
	/** 0=So .. 6=Sa */
	weekday: number;
}

/** Die Kalender-Bestandteile eines Zeitstempels in der gegebenen Zone. */
export function zonedParts(ts: number, tz = currentZone): ZonedParts {
	const parts = formatter(tz).formatToParts(new Date(ts));
	const get = (type: string) => {
		const p = parts.find((x) => x.type === type);
		return p ? Number(p.value) : 0;
	};
	const year = get("year");
	const month = get("month");
	const day = get("day");
	// Den Wochentag aus den Bestandteilen rechnen statt ihn formatieren zu lassen:
	// die Namen haengen an der Sprache, die Zahl nicht.
	const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
	return { year, month, day, hour: get("hour"), minute: get("minute"), second: get("second"), weekday };
}

/**
 * Der Abstand der Zone zu UTC an diesem Zeitpunkt, in Millisekunden.
 *
 * Gepuffert je angefangener Stunde: Sommerzeit-Wechsel liegen auf vollen
 * Stunden, die Puffer-Grenze ist damit exakt und nicht nur ungefaehr. Ohne den
 * Puffer laeuft `formatToParts` in Auswertungen ueber ein ganzes Jahr
 * zehntausendfach.
 */
function zoneOffsetMs(ts: number, tz = currentZone): number {
	const key = `${tz}|${Math.floor(ts / 3_600_000)}`;
	const hit = offsetCache.get(key);
	if (hit !== undefined) return hit;
	const p = zonedParts(ts, tz);
	const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
	// Die Millisekunden fallen bei der Formatierung weg und muessen zurueck, sonst
	// waere der Abstand um bis zu 999 ms daneben.
	const off = asUtc - (Math.floor(ts / 1000) * 1000);
	offsetCache.set(key, off);
	return off;
}

const offsetCache = new Map<string, number>();

/**
 * Der Zeitstempel zu einer Wanduhr-Angabe in der gegebenen Zone.
 *
 * Zweistufig, weil der Abstand zu UTC selbst vom Ergebnis abhaengt: der erste
 * Versuch nimmt den Abstand am geratenen Zeitpunkt, der zweite prueft ihn am
 * tatsaechlich getroffenen. Ohne das laege jede Angabe rund um eine
 * Sommerzeit-Umstellung eine Stunde daneben.
 *
 * Sonderfaelle der Umstellung:
 *  - Die uebersprungene Stunde im Fruehjahr gibt es nicht; sie faellt nach vorn
 *    auf den ersten existierenden Zeitpunkt.
 *  - Die doppelte Stunde im Herbst gibt es zweimal; genommen wird die erste.
 */
export function wallToTs(
	year: number,
	month: number,
	day: number,
	hour = 0,
	minute = 0,
	second = 0,
	tz = currentZone
): number {
	const wall = Date.UTC(year, month - 1, day, hour, minute, second);
	// Beide moeglichen Abstaende holen – einen weit vor und einen weit nach dem
	// gemeinten Zeitpunkt. An einem Umstellungstag sind das zwei verschiedene, an
	// jedem anderen Tag zweimal derselbe.
	const before = zoneOffsetMs(wall - HALF_DAY_MS, tz);
	const after = zoneOffsetMs(wall + HALF_DAY_MS, tz);
	const a = wall - before;
	const b = wall - after;
	// Ein Kandidat zaehlt nur, wenn die Zone an IHM auch wirklich den Abstand hat,
	// mit dem er gerechnet wurde. Sonst beschreibt er eine Wanduhrzeit, die es an
	// diesem Tag nie gab.
	const aOk = zoneOffsetMs(a, tz) === before;
	const bOk = zoneOffsetMs(b, tz) === after;
	if (aOk && bOk) return Math.min(a, b); // doppelte Stunde: das erste Vorkommen
	if (aOk) return a;
	if (bOk) return b;
	// Luecke: die Wanduhrzeit wurde uebersprungen. Nach vorn auf den ersten
	// existierenden Zeitpunkt – der Tag bleibt damit der gemeinte.
	return Math.max(a, b);
}

const HALF_DAY_MS = 12 * 3_600_000;

/** Wie `wallToTs`, aber aus einem "YYYY-MM-DD" und "HH:MM". NaN bei Unsinn. */
export function wallStringToTs(date: string, time: string, tz = currentZone): number {
	const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date.trim());
	const t = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(time.trim());
	if (!d || !t) return NaN;
	const hour = Number(t[1]);
	const minute = Number(t[2]);
	if (hour > 23 || minute > 59) return NaN;
	return wallToTs(
		Number(d[1]),
		Number(d[2]),
		Number(d[3]),
		hour,
		minute,
		t[3] ? Number(t[3]) : 0,
		tz
	);
}

/**
 * Ein Kalenderdatum um Tage verschieben – rein im Kalender, ohne Zeitzone.
 *
 * Bewusst nicht ueber Zeitstempel: eine Addition von 24 Stunden trifft an einer
 * Sommerzeit-Grenze den falschen Tag, die Kalenderrechnung nie.
 */
export function addCalendarDays(date: string, delta: number): string {
	const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date.trim());
	if (!m) return date;
	const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
	d.setUTCDate(d.getUTCDate() + delta);
	return isoDate(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
}

/** "YYYY-MM-DD" aus Bestandteilen. */
export function isoDate(year: number, month: number, day: number): string {
	return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** Nur fuer Tests: die gepufferten Abstaende vergessen. */
export function resetTimeZoneCaches(): void {
	offsetCache.clear();
	formatters.clear();
}

/** Wochentag (0=So..6=Sa) eines "YYYY-MM-DD" – reine Kalenderrechnung. */
export function weekdayOfDate(date: string): number {
	const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date.trim());
	if (!m) return NaN;
	return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))).getUTCDay();
}

/** Anzahl Tage eines Monats – reine Kalenderrechnung, `month` ist 1-basiert. */
export function daysInMonth(year: number, month: number): number {
	return new Date(Date.UTC(year, month, 0)).getUTCDate();
}
