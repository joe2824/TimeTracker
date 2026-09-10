/** Herkunfts- und Änderungsspuren für den Abgleich mit dem Server. */
export interface SyncMeta {
	/** Letzte Änderung als Epoch-ms der schreibenden Uhr. */
	updatedAt?: number;
	/** Zähler, den der Server vergibt. Lokal nur weitergereicht. */
	rev?: number;
	/** Welches Gerät zuletzt geschrieben hat. */
	deviceId?: string;
}

export interface Activity extends SyncMeta {
	id: string;
	name: string;
	sortOrder: number;
	archived: boolean;
	/** true = eingebaute Pseudo-Zeile "Abwesenheiten" */
	isAbsence: boolean;
	/** als Favorit markiert (häufig genutzt) */
	favorite?: boolean;
	/** aus der Auswahl ausgeblendet, erscheint aber weiterhin im Bericht/E-Mail */
	hidden?: boolean;
	/** globaler Shortcut (Accelerator, z.B. "Control+Alt+1" oder "F13") zum Timer-Start */
	shortcut?: string;
	/** Farbe (Hex, z.B. "#22c55e") für Punkte in Liste/Bericht/Heatmap */
	color?: string;
	/**
	 * Vom Team vorgegeben, nicht lokal - id trägt das Präfix "team:" (siehe
	 * team/activities.ts). Bearbeiten/Löschen bleibt dem Chef vorbehalten.
	 */
	teamOwned?: boolean;
}

/**
 * Feste Farbe für Zeitausgleich.
 *
 * Violett, nicht Sky: Sky heisst in der Tagesliste bereits "hier steht zu viel
 * Zeit", und dieselbe Farbe darf nicht zweierlei bedeuten.
 */
export const TIME_OFF_COLOR = "#8b5cf6";

/** Auswahl-Palette für Aktivitäts-Farben. */
export const ACTIVITY_COLORS = [
	"#ef4444",
	"#f97316",
	"#eab308",
	"#22c55e",
	"#14b8a6",
	"#3b82f6",
	"#6366f1",
	"#a855f7",
	"#ec4899",
	"#64748b"
];

/** Woher ein Eintrag stammt. "loga" = aus einem Zeitwirtschaftsreport nachgetragen. */
export type EntrySource = "timer" | "manual" | "calendar" | "loga";

export interface Entry extends SyncMeta {
	id: string;
	activityId: string;
	/** Start als Epoch-Millisekunden */
	startTs: number;
	/** Ende als Epoch-ms; null = läuft gerade */
	endTs: number | null;
	note: string;
	source: EntrySource;
	/**
	 * Nur für Abwesenheits-Einträge: Tagesanteil (1 = ganzer Tag, 0.5 = halber Tag).
	 * Die Stunden werden als dayFraction * settings.hoursPerDay berechnet.
	 */
	dayFraction?: number;
	/**
	 * Nur für Abwesenheits-Einträge: abgefeierte Überstunden statt Urlaub oder
	 * Krankheit.
	 *
	 * Erfasst wird er wie ein Urlaubstag - ganzer oder halber Tag auf derselben
	 * Zeile. Verrechnet wird er genau andersherum: ein Urlaubstag füllt das
	 * Tagessoll, ein Zeitausgleich lässt es offen. Dadurch sinkt der Saldo um die
	 * Stunden des Tages, und genau das feiert die Überstunden ab. Im Bericht an
	 * den Chef taucht er nicht auf.
	 */
	timeOff?: boolean;
}

export interface Settings {
	/** Erinnerungszeiten im Format "HH:MM" */
	reminderTimes: string[];
	bossEmail: string;
	senderName: string;
	/** Rundung in Stunden, z.B. 0.5 */
	rounding: number;
	autostart: boolean;
	/** Stunden eines vollen Arbeitstags (für Abwesenheits-Umrechnung) */
	hoursPerDay: number;
	/**
	 * Pause automatisch von der Tagesarbeitszeit abziehen (ab 4 h 15 min, ab 6 h
	 * 45 min) – wie LOGA es tut. Wirkt auf Tagessummen, Bericht und Auswertung;
	 * die erfassten Einträge selbst bleiben unverändert.
	 */
	breakDeduction: boolean;
	/** Reguläre Arbeitstage als Wochentagsnummern (0=So .. 6=Sa), Standard Mo–Fr */
	workdays: number[];
	/** Stichwort (lowercase) -> activityId für Kalender-Auto-Zuordnung */
	calendarKeywordMap: Record<string, string>;
	reportSubjectTemplate: string;
	/** Leerlauf-Erkennung: Minuten ohne Eingabe, ab denen gefragt wird (0 = aus) */
	idleThresholdMin: number;
	/** Auto-Stop-Warnung: Timer läuft länger als X Stunden (0 = aus) */
	maxTimerHours: number;
	/** globaler Hotkey zum Starten/Stoppen des letzten Timers */
	toggleShortcut: string;
	/** Pomodoro/Pausen-Erinnerung aktiv */
	pomodoroEnabled: boolean;
	/** Fokus-Dauer in Minuten bis zur Pausen-Erinnerung */
	pomodoroMin: number;
	/** Pausendauer in Minuten (0 = nur Fokus-Hinweis ohne Pausenzyklus) */
	pomodoroBreakMin: number;
	/** Kurze (auto-schließende) Benachrichtigung beim Start/Stop per Shortcut/Hotkey */
	shortcutNotify: boolean;
	/** Monatliche Erinnerung, den Bericht an die Vorgesetzten zu senden */
	reportReminderEnabled: boolean;
	/** Uhrzeit der Berichts-Erinnerung am letzten Werktag des Monats ("HH:MM") */
	reportReminderTime: string;
	/** Wie viele Werktage VOR dem letzten Werktag erinnert wird (0 = letzter Werktag) */
	reportReminderLeadDays: number;
	/** Monate (YYYY-MM), deren Bericht gesendet oder bewusst ignoriert wurde */
	reportSentMonths: string[];
	/** Auswertung (Saldo, Stunden je Aktivität, Jahres-Heatmap) im Bericht zeigen */
	statsEnabled: boolean;
	/**
	 * Arbeitszeit-Check (ArbZG) im Bericht zeigen: Ausgleichszeitraum über 24
	 * Wochen samt Prognose, dazu Tagesgrenzen, Ruhezeit und Sonntagsarbeit.
	 */
	arbzgEnabled: boolean;
	/** Kurzer Hinweis auf der Tracking-Seite, wenn der Arbeitszeit-Check anschlägt. */
	arbzgTrackingHint: boolean;
	/** Chef-Modus: Tab „Team" zum Anlegen von Teams und Verwalten der Mitglieder */
	bossMode: boolean;
	/** Vorabversionen beziehen. Liest auch der Rust-Teil aus der settings.json - wirkt erst nach Neustart. */
	betaUpdates: boolean;
	/** Zeitzone des Kontos als IANA-Kennung, z.B. "Europe/Berlin". */
	timeZone: string;
	/** Tag (YYYY-MM-DD), an dem zuletzt „aktiv" gemeldet wurde. */
	usageLastDay: string;
}

/** Standard-Betreff des Monatsberichts. */
export const DEFAULT_SUBJECT = "Stundenerfassung {month} – {name}";

export const defaultSettings: Settings = {
	reminderTimes: ["14:00"],
	bossEmail: "",
	senderName: "",
	rounding: 0.5,
	autostart: true,
	hoursPerDay: 7.5,
	breakDeduction: true,
	workdays: [1, 2, 3, 4, 5],
	calendarKeywordMap: {},
	reportSubjectTemplate: DEFAULT_SUBJECT,
	idleThresholdMin: 10,
	maxTimerHours: 10,
	toggleShortcut: "",
	pomodoroEnabled: false,
	pomodoroMin: 50,
	pomodoroBreakMin: 10,
	shortcutNotify: true,
	reportReminderEnabled: true,
	reportReminderTime: "16:00",
	reportReminderLeadDays: 0,
	reportSentMonths: [],
	statsEnabled: true,
	arbzgEnabled: true,
	arbzgTrackingHint: true,
	bossMode: false,
	betaUpdates: false,
	timeZone: "",
	usageLastDay: ""
};

/** Namen der eingebauten Zeilen, die immer im Bericht erscheinen. */
export const BUILTIN_OTHERS = "Others";
export const BUILTIN_ABSENCE = "Abwesenheiten";

/**
 * Feste Ids der eingebauten Zeilen.
 *
 * Bewusst KEINE Zufalls-Id: sie werden auf jedem Gerät angelegt, und zwar
 * bevor der erste Abgleich gelaufen ist. Mit einer Zufalls-Id legt jedes Gerät
 * eine eigene Fassung an, der Abgleich vergleicht nach Id, findet keine
 * Übereinstimmung - und die Liste hätte "Others" und "Abwesenheiten" doppelt
 * und dreifach. Mit einer festen Id entsteht überall derselbe Datensatz.
 */
export const BUILTIN_OTHERS_ID = "builtin-others";
export const BUILTIN_ABSENCE_ID = "builtin-absence";

/** Präfix der lokalen Id einer vom Team vorgegebenen Zeile - kann nie mit einer selbst angelegten (crypto.randomUUID()) kollidieren. */
export const TEAM_ACTIVITY_PREFIX = "team:";

/**
 * Die eingebauten Zeilen - „Others“ und die Abwesenheiten.
 *
 * Über den Namen und nicht über die feste Id: ältere Fassungen vergaben
 * hier Zufalls-Ids, und solange die noch nicht zusammengeführt sind
 * (`app.svelte.ts`), trägt die Zeile eine andere Id als heute.
 */
export function isBuiltinActivity(a: Activity): boolean {
	return a.isAbsence || a.name === BUILTIN_OTHERS;
}

/**
 * Die Reihenfolge der Aktivitätenliste: eingebaute Zeilen immer zuletzt.
 *
 * Sie lassen sich weder löschen noch umbenennen und gehören deshalb nicht
 * zwischen die selbst angelegten. `persistActivities` zieht die
 * gespeicherte Reihenfolge nach; hier steht dieselbe Regel für das, was
 * angezeigt wird - eine Liste von einem anderen Gerät stimmt sonst erst
 * nach dem nächsten Schreibvorgang.
 */
export function byActivityOrder(a: Activity, b: Activity): number {
	return (
		Number(isBuiltinActivity(a)) - Number(isBuiltinActivity(b)) || a.sortOrder - b.sortOrder
	);
}
