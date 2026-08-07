// Zeitwirtschaftsreport aus LOGA (Scout -> "gesetzliche Arbeitszeitverstöße").
//
// Die Datei hat EINE Zeile je Person und Kalendertag. Massgeblich ist die Spalte
// "Arbeitszeit täglich": das ist die NETTO-Arbeitszeit, die Pause hat LOGA schon
// abgezogen. Genau diese Zahl wird spaeter gegen die erfassten Projektzeiten
// gestellt (siehe timeReconcile.ts).
//
// Zugeordnet wird ueber die KOPFZEILE, nicht ueber feste Spaltennummern: der
// Report ist konfigurierbar, und eine zusaetzliche oder fehlende Spalte haette
// sonst alles dahinter stillschweigend verschoben.
import type { XlsxSheet } from "./xlsx";

/** Ein gesetzter Verstoss-Hinweis aus dem Report. */
export interface TimeReportFlag {
	key: "ruhepause" | "ueber10" | "soll10" | "wiedereingliederung" | "sonntag" | "feiertag";
	/** Kurzform fuer ein Badge, z.B. "> 10 h" */
	label: string;
	/** Inhalt der Zelle – manche Spalten tragen Stunden statt eines Kreuzes. */
	value: string;
}

export interface TimeReportDay {
	/** "YYYY-MM-DD" */
	date: string;
	/** "Erstes kommen" als "HH:MM", null wenn nicht gestempelt */
	firstIn: string | null;
	/** "Letztes gehen" als "HH:MM", null wenn nicht gestempelt */
	lastOut: string | null;
	/** "Arbeitszeit täglich" in Dezimalstunden (netto, Pause bereits abgezogen) */
	hours: number;
	flags: TimeReportFlag[];
}

export interface TimeReportPerson {
	/** Stabiler Schluessel fuer die Auswahl: Personalnummer, sonst der Name. */
	key: string;
	personnelNo: string;
	/** "Vorname Nachname", sonst was davon da ist. */
	name: string;
	/** Aufsteigend nach Datum, ohne Dubletten. */
	days: TimeReportDay[];
}

export interface ParsedTimeReport {
	people: TimeReportPerson[];
	/** Alle vorkommenden Monate ("YYYY-MM"), aufsteigend. */
	months: string[];
}

/** Der Inhalt passt nicht zu einem Zeitwirtschaftsreport. */
export class TimeReportError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "TimeReportError";
	}
}

// ---------- Kopfzeile ----------

/** Vergleichsform einer Ueberschrift: ohne Rand, klein, Leerraum vereinheitlicht. */
function normalizeHeader(s: string): string {
	return s.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Spalten des Reports. Der Schluessel ist intern, die Liste enthaelt die
 * Ueberschriften, unter denen die Spalte auftauchen darf.
 *
 * "arbeitszeit täglich" und "arbeitszeit täglich > 10h" beginnen gleich – hier
 * wird deshalb EXAKT verglichen, nie per Praefix.
 */
const COLUMNS = {
	personnelNo: ["personalnummer", "personalnr.", "personalnr"],
	lastName: ["nachname", "name"],
	firstName: ["vorname"],
	date: ["tag", "datum"],
	firstIn: ["erstes kommen"],
	lastOut: ["letztes gehen"],
	hours: ["arbeitszeit täglich"],
	ruhepause: ["verstoß ruhepause", "verstoss ruhepause"],
	ueber10: ["arbeitszeit täglich > 10h", "arbeitszeit täglich >10h"],
	soll10: ["soll arbeitszeit > 10h", "soll arbeitszeit >10h"],
	wiedereingliederung: ["wiedereingliederung"],
	sonntag: ["arbeit am sonntag"],
	feiertag: ["arbeit am feiertag"]
} as const;

type ColumnKey = keyof typeof COLUMNS;
type ColumnMap = Partial<Record<ColumnKey, number>>;

const FLAG_LABELS: Record<TimeReportFlag["key"], string> = {
	ruhepause: "Ruhepause",
	ueber10: "> 10 h",
	soll10: "Soll > 10 h",
	wiedereingliederung: "Wiedereingliederung",
	sonntag: "Sonntag",
	feiertag: "Feiertag"
};

const FLAG_KEYS = Object.keys(FLAG_LABELS) as TimeReportFlag["key"][];

/** Kopfzeile suchen und Spalten zuordnen. Null, wenn die Zeile keine ist. */
function mapHeader(row: string[]): ColumnMap | null {
	const map: ColumnMap = {};
	for (let i = 0; i < row.length; i++) {
		const label = normalizeHeader(row[i] ?? "");
		if (!label) continue;
		for (const key of Object.keys(COLUMNS) as ColumnKey[]) {
			// Erste Fundstelle gewinnt: eine doppelte Ueberschrift soll die schon
			// zugeordnete Spalte nicht ueberschreiben.
			if (map[key] === undefined && (COLUMNS[key] as readonly string[]).includes(label)) {
				map[key] = i;
				break;
			}
		}
	}
	// Ohne Datum und Stundenspalte ist es keine verwertbare Kopfzeile.
	return map.date !== undefined && map.hours !== undefined ? map : null;
}

// ---------- Zellen ----------

/**
 * Excel-Serienzahl -> "YYYY-MM-DD".
 *
 * Epoche ist der 30.12.1899, nicht der 01.01.1900: Excel kennt einen
 * 29.02.1900, den es nie gab, und gleicht diesen Fehler mit dem
 * Zwei-Tage-Versatz aus. Gerechnet wird in UTC, damit keine Zeitzone einen
 * Tag verschiebt – das Ergebnis ist ein reines Kalenderdatum.
 */
export function serialToDate(serial: number): string | null {
	if (!Number.isFinite(serial) || serial < 1) return null;
	const d = new Date(Date.UTC(1899, 11, 30) + Math.floor(serial) * 86400000);
	if (Number.isNaN(d.getTime())) return null;
	return d.toISOString().slice(0, 10);
}

/** Datumszelle lesen: Serienzahl, ISO ("2026-01-31") oder deutsch ("31.01.2026"). */
export function parseReportDate(raw: string): string | null {
	const t = raw.trim();
	if (!t) return null;
	const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(t);
	if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
	const de = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(t);
	if (de) {
		return `${de[3]}-${de[2].padStart(2, "0")}-${de[1].padStart(2, "0")}`;
	}
	const n = Number(t.replace(",", "."));
	return Number.isFinite(n) ? serialToDate(n) : null;
}

/**
 * Uhrzeitzelle lesen -> "HH:MM". Akzeptiert "09:10" und den Excel-Tagesbruch
 * (0,38194 = 09:10), den manche Exporte statt Text liefern.
 */
export function parseReportClock(raw: string): string | null {
	const t = raw.trim();
	if (!t) return null;
	const hm = /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(t);
	if (hm) {
		const h = Number(hm[1]);
		const m = Number(hm[2]);
		if (h > 23 || m > 59) return null;
		return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
	}
	const n = Number(t.replace(",", "."));
	// Die 0 gilt als „nicht gestempelt", nicht als Mitternacht: als Uhrzeit gelesen
	// entstuende aus einem Urlaubstag ein Anwesenheitsfenster ab 00:00, und der
	// Nachtrag legte Projektzeit mitten in die Nacht.
	if (!Number.isFinite(n) || n <= 0 || n >= 1) return null;
	// Auf Minuten runden; 23:59:30 darf nicht auf 24:00 kippen.
	const min = Math.min(1439, Math.round(n * 1440));
	return `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
}

/** Stundenzelle lesen. 0 bei leer oder unlesbar. */
export function parseReportHours(raw: string): number {
	const t = raw.trim();
	if (!t) return 0;
	// "7:30" kommt vor, wenn die Spalte als Uhrzeit formatiert ist.
	const hm = /^(\d{1,3}):(\d{2})$/.exec(t);
	if (hm) return Number(hm[1]) + Number(hm[2]) / 60;
	const n = Number(t.replace(",", "."));
	return Number.isFinite(n) && n >= 0 ? n : 0;
}

// ---------- Pause ----------

/**
 * Pausenregel des Hauses: ab 4 h 15 Minuten, ab 6 h weitere 30 Minuten
 * (zusammen 45). LOGA zieht sie automatisch von der Anwesenheit ab.
 *
 * Nur ein Rueckfall fuer Tage OHNE Stempel – wo Kommen und Gehen vorliegen,
 * ist die tatsaechliche Pause aus Brutto minus Netto ablesbar und damit
 * genauer (siehe breakHours).
 */
export function ruleBreakHours(grossHours: number): number {
	if (grossHours > 6) return 0.75;
	if (grossHours > 4) return 0.25;
	return 0;
}

/** Anwesenheit laut Stempeln in Stunden. 0, wenn nicht gestempelt wurde. */
export function grossHours(day: TimeReportDay): number {
	if (!day.firstIn || !day.lastOut) return 0;
	const [ih, im] = day.firstIn.split(":").map(Number);
	const [oh, om] = day.lastOut.split(":").map(Number);
	let min = oh * 60 + om - (ih * 60 + im);
	if (min < 0) min += 1440; // ueber Mitternacht gestempelt
	return min / 60;
}

/**
 * Die Pause dieses Tages in Stunden.
 *
 * Aus Brutto minus Netto, wo beides vorliegt: das trifft auch Tage mit einer
 * ZUSAETZLICH gestempelten Pause, die keine Regel vorhersagen kann (im Beispiel
 * 08:47–18:18 mit 8,27 h netto, also 1,25 h statt der erwarteten 0,75 h).
 * Sonst die Hausregel.
 */
export function breakHours(day: TimeReportDay): number {
	const gross = grossHours(day);
	if (gross <= 0) return 0;
	const measured = gross - day.hours;
	return measured > 0 ? measured : ruleBreakHours(gross);
}

/** Wurde an diesem Tag gestempelt? */
export function hasStamps(day: TimeReportDay): boolean {
	return !!day.firstIn && !!day.lastOut;
}

/**
 * In LOGA ist nur „Kommen" gestempelt – das Gehen fehlt noch.
 *
 * So ein Tag ist kein Massstab: „Arbeitszeit täglich" steht dann auf 0 oder auf
 * einem Zwischenstand, weil LOGA den Feierabend noch nicht kennt. Alles, was
 * hier erfasst ist, saehe daneben nach „zu viel" aus.
 *
 * Trifft den laufenden Tag ebenso wie ein vergessenes Gehen in der
 * Vergangenheit – beides ist in LOGA zu klaeren, nicht hier.
 */
export function isOpenDay(day: TimeReportDay): boolean {
	return !!day.firstIn && !day.lastOut;
}

// ---------- Einlesen ----------

/**
 * Einen eingelesenen Zeitwirtschaftsreport auswerten.
 *
 * Mehrere Personen sind vorgesehen: der Export laesst sich auch fuer ein ganzes
 * Team ziehen (der Report hat eine Spalte "Vorgesetzter"). Die Oberflaeche
 * fragt dann, um wen es geht.
 *
 * @throws {TimeReportError} wenn keine Kopfzeile oder keine Datenzeile passt
 */
export function parseTimeReport(sheet: XlsxSheet): ParsedTimeReport {
	let header: ColumnMap | null = null;
	let firstDataRow = 0;
	// Die Kopfzeile steht ganz oben – ein paar Zeilen Vorspann (Titel, Zeitraum)
	// kosten nichts und kommen in konfigurierten Exporten vor.
	for (let i = 0; i < Math.min(sheet.rows.length, 20); i++) {
		const map = mapHeader(sheet.rows[i] ?? []);
		if (map) {
			header = map;
			firstDataRow = i + 1;
			break;
		}
	}
	if (!header) {
		throw new TimeReportError(
			'Keine passende Kopfzeile gefunden – erwartet werden die Spalten „Tag" und „Arbeitszeit täglich".'
		);
	}

	const cell = (row: string[], key: ColumnKey): string => {
		const i = header[key];
		return i === undefined ? "" : (row[i] ?? "");
	};

	const byPerson = new Map<string, TimeReportPerson>();
	// Pro Person: Datum -> Tag, damit eine doppelte Zeile den Tag nicht verdoppelt.
	const seen = new Map<string, Map<string, TimeReportDay>>();

	for (let i = firstDataRow; i < sheet.rows.length; i++) {
		const row = sheet.rows[i] ?? [];
		const date = parseReportDate(cell(row, "date"));
		if (!date) continue; // Leerzeile, Summenzeile, Fussnote

		const personnelNo = cell(row, "personnelNo").trim();
		const lastName = cell(row, "lastName").trim();
		const firstName = cell(row, "firstName").trim();
		const key = personnelNo || `${lastName}, ${firstName}`.trim() || "?";

		let person = byPerson.get(key);
		if (!person) {
			person = {
				key,
				personnelNo,
				name: [firstName, lastName].filter(Boolean).join(" ") || personnelNo || "Unbekannt",
				days: []
			};
			byPerson.set(key, person);
			seen.set(key, new Map());
		}

		const flags: TimeReportFlag[] = [];
		for (const flag of FLAG_KEYS) {
			const value = cell(row, flag).trim();
			if (value) flags.push({ key: flag, label: FLAG_LABELS[flag], value });
		}

		const day: TimeReportDay = {
			date,
			firstIn: parseReportClock(cell(row, "firstIn")),
			lastOut: parseReportClock(cell(row, "lastOut")),
			hours: parseReportHours(cell(row, "hours")),
			flags
		};

		const days = seen.get(key)!;
		const prev = days.get(date);
		if (prev) {
			// Zwei Zeilen fuer denselben Tag: Stunden addieren, Stempel aussen fassen.
			prev.hours += day.hours;
			if (!prev.firstIn || (day.firstIn && day.firstIn < prev.firstIn)) prev.firstIn = day.firstIn;
			if (!prev.lastOut || (day.lastOut && day.lastOut > prev.lastOut)) prev.lastOut = day.lastOut;
			for (const f of day.flags) if (!prev.flags.some((x) => x.key === f.key)) prev.flags.push(f);
		} else {
			days.set(date, day);
			person.days.push(day);
		}
	}

	const people = [...byPerson.values()];
	if (people.length === 0) {
		throw new TimeReportError("Die Datei enthält keine auswertbaren Tageszeilen.");
	}
	for (const p of people) p.days.sort((a, b) => a.date.localeCompare(b.date));
	people.sort((a, b) => a.name.localeCompare(b.name, "de"));

	const months = new Set<string>();
	for (const p of people) for (const d of p.days) months.add(d.date.slice(0, 7));

	return { people, months: [...months].sort() };
}
