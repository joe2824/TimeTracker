// Datei-Protokoll fuer die Fehlersuche nach dem Fakt.
import { storage } from "./platform/fs";
import { fmtDate } from "./time";
import { zonedParts } from "./tz";
import { redact, trackError } from "./analytics";

export type LogLevel = "debug" | "info" | "warn" | "error";

const DIR = "logs";
const FILE_RE = /^(\d{4}-\d{2}-\d{2})\.log$/;

/** So viele Tage bleiben liegen; aeltere raeumt pruneOldLogs() beim Start weg. */
export const KEEP_DAYS = 14;

/** Pfad der Tagesdatei, relativ zum App-Datenordner. */
export function logFile(ts = Date.now()): string {
	return `${DIR}/${fmtDate(ts)}.log`;
}

/** Ordner der Protokolle, relativ zum App-Datenordner. */
export const LOG_DIR = DIR;

/** Lesbarer Text zu einem geworfenen Wert. */
export function errorText(e: unknown): string {
	if (e instanceof Error) return e.message || e.name;
	if (typeof e === "string") return e;
	try {
		return JSON.stringify(e);
	} catch {
		return String(e);
	}
}

/** Zusatzangaben einer Zeile. Bei Fehlern moeglichst mit Aufrufliste. */
function detailText(detail: unknown): string {
	if (detail instanceof Error && detail.stack) return detail.stack;
	if (typeof detail === "object" && detail !== null && !(detail instanceof Error)) {
		try {
			return JSON.stringify(detail);
		} catch {
			return String(detail);
		}
	}
	return errorText(detail);
}

/** "2026-07-28 13:45:02.123" in der Zeitzone des Kontos – dieselbe wie alle Anzeigen. */
function stamp(ts: number): string {
	const z = zonedParts(ts);
	const p = (n: number, len = 2) => String(n).padStart(len, "0");
	return `${fmtDate(ts)} ${p(z.hour)}:${p(z.minute)}:${p(z.second)}.${p(ts % 1000, 3)}`;
}

/**
 * Welches Fenster schreibt. Beide teilen sich die Tagesdatei – ohne diese
 * Kennung waere hinterher nicht zu unterscheiden, ob ein Timer im Hauptfenster
 * oder im Tray-Flyout gestartet wurde.
 */
function windowLabel(): string {
	if (typeof location === "undefined") return "test";
	return location.pathname.startsWith("/tray") ? "tray" : "main";
}

// ---- Puffer ----
// Gesammelt schreiben, statt fuer jede Zeile ueber IPC zu gehen. Fehler und
// Warnungen gehen sofort raus: die letzte Zeile vor einem Absturz ist die
// interessanteste, und die darf nicht im Puffer verhungern.
let pending: string[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let writing: Promise<void> = Promise.resolve();
let dirReady = false;

function schedule(): void {
	if (flushTimer !== null) return;
	flushTimer = setTimeout(() => {
		flushTimer = null;
		void flushLog();
	}, 500);
}

async function writePending(): Promise<void> {
	if (pending.length === 0) return;
	const lines = pending;
	pending = [];
	try {
		// Einmal je Sitzung pruefen: das Protokoll schreibt oft, und jede Pruefung
		// waere eine weitere Runde ueber die IPC-Bruecke.
		if (!dirReady) {
			if (!(await storage.exists(DIR))) await storage.mkdir(DIR);
			dirReady = true;
		}
		await storage.appendTextFile(logFile(), `${lines.join("\n")}\n`);
	} catch (e) {
		// Verlorene Zeilen sind besser als eine App, die am Protokollieren scheitert.
		// Deshalb auch kein erneuter Versuch: dann haenge das Protokoll im Kreis.
		console.error("Protokoll konnte nicht geschrieben werden", e, lines);
	}
}

/** Alles Angesammelte wegschreiben. Schreibvorgaenge laufen nacheinander. */
export function flushLog(): Promise<void> {
	if (flushTimer !== null) {
		clearTimeout(flushTimer);
		flushTimer = null;
	}
	writing = writing.then(writePending, writePending);
	return writing;
}

function record(level: LogLevel, message: string, detail?: unknown): void {
	// Fortsetzungszeilen (Aufruflisten) einruecken: so bleibt sichtbar, dass sie
	// zum Eintrag darueber gehoeren, und die Protokoll-Karte kann sie beim Filtern
	// mitnehmen, statt einen Fehler ohne seinen Stack zu zeigen.
	const line = `${stamp(Date.now())} ${windowLabel().padEnd(4)} ${level.toUpperCase().padEnd(5)} ${message}${
		detail === undefined ? "" : ` | ${detailText(detail)}`
	}`.replace(/\n/g, "\n\t");
	// Konsole behalten: beim Entwickeln ist sie schneller zur Hand als die Datei.
	if (level === "error") console.error(line);
	else if (level === "warn") console.warn(line);
	else console.log(line);

	pending.push(line);
	if (level === "error" || level === "warn") void flushLog();
	else schedule();

	// Fehler zusaetzlich anonym zaehlen – nur so ist zu sehen, ob eine Fassung
	// bei den Kollegen reihenweise auf etwas laeuft, das hier nie auftritt.
	// trackError() und nicht track(): das haengt am Schalter.
	if (level === "error") {
		void trackError("fehler", { meldung: redact(message) });
	}
}

export function logDebug(message: string, detail?: unknown): void {
	record("debug", message, detail);
}
export function logInfo(message: string, detail?: unknown): void {
	record("info", message, detail);
}
export function logWarn(message: string, detail?: unknown): void {
	record("warn", message, detail);
}
export function logError(message: string, detail?: unknown): void {
	record("error", message, detail);
}

/** Unbehandelte Fehler und Promise-Ablehnungen des Fensters mitschreiben. */
export function installErrorLogging(): () => void {
	const onError = (e: ErrorEvent) => {
		logError(`Unbehandelter Fehler: ${e.message}`, e.error ?? `${e.filename}:${e.lineno}`);
	};
	const onRejection = (e: PromiseRejectionEvent) => {
		logError("Unbehandelte Promise-Ablehnung", e.reason);
	};
	window.addEventListener("error", onError);
	window.addEventListener("unhandledrejection", onRejection);
	return () => {
		window.removeEventListener("error", onError);
		window.removeEventListener("unhandledrejection", onRejection);
	};
}

/** Vorhandene Protokolldateien, neueste zuerst. */
export async function listLogs(): Promise<string[]> {
	try {
		if (!(await storage.exists(DIR))) return [];
		const dir = await storage.readDir(DIR);
		return dir
			.map((e) => e.name ?? "")
			.filter((n) => FILE_RE.test(n))
			.sort()
			.reverse();
	} catch (e) {
		console.error("Protokolle nicht lesbar", e);
		return [];
	}
}

/** Die letzten Zeilen des Protokolls, aelteste zuerst. */
export async function readLog(maxLines = 300): Promise<string[]> {
	await flushLog();
	const names = (await listLogs()).slice(0, 2).reverse();
	const lines: string[] = [];
	for (const name of names) {
		try {
			const txt = await storage.readTextFile(`${DIR}/${name}`);
			lines.push(...txt.split("\n").filter((l) => l.trim()));
		} catch (e) {
			console.error(`Protokoll ${name} nicht lesbar`, e);
		}
	}
	return lines.slice(-maxLines);
}

/** Alle Protokolldateien loeschen. Liefert die Anzahl. */
export async function clearLogs(): Promise<number> {
	await flushLog();
	const names = await listLogs();
	let removed = 0;
	for (const name of names) {
		try {
			await storage.remove(`${DIR}/${name}`);
			removed++;
		} catch (e) {
			console.error(`Protokoll ${name} nicht loeschbar`, e);
		}
	}
	return removed;
}

/** Protokolle aelter als `keepDays` entfernen. Liefert die geloeschten Namen. */
export async function pruneOldLogs(keepDays = KEEP_DAYS, now = Date.now()): Promise<string[]> {
	const cutoff = fmtDate(now - keepDays * 24 * 60 * 60 * 1000);
	const removed: string[] = [];
	for (const name of await listLogs()) {
		const day = name.match(FILE_RE)?.[1];
		// Datumsnamen vergleichen sich als Text richtig (ISO-Reihenfolge).
		if (!day || day >= cutoff) continue;
		try {
			await storage.remove(`${DIR}/${name}`);
			removed.push(name);
		} catch (e) {
			console.error(`Altes Protokoll ${name} nicht loeschbar`, e);
		}
	}
	return removed;
}
