/** Herkunfts- und Aenderungsspuren fuer den Abgleich mit dem Server. */
export interface SyncMeta {
	/** Letzte Aenderung als Epoch-ms der schreibenden Uhr. */
	updatedAt?: number;
	/** Zaehler, den der Server vergibt. Lokal nur weitergereicht. */
	rev?: number;
	/** Welches Geraet zuletzt geschrieben hat. */
	deviceId?: string;
}

export interface Activity extends SyncMeta {
	id: string;
	name: string;
	sortOrder: number;
	archived: boolean;
	/** true = eingebaute Pseudo-Zeile "Abwesenheiten" */
	isAbsence: boolean;
	/** als Favorit markiert (haeufig genutzt) */
	favorite?: boolean;
	/** aus der Auswahl ausgeblendet, erscheint aber weiterhin im Bericht/E-Mail */
	hidden?: boolean;
	/** globaler Shortcut (Accelerator, z.B. "Control+Alt+1" oder "F13") zum Timer-Start */
	shortcut?: string;
	/** Farbe (Hex, z.B. "#22c55e") fuer Punkte in Liste/Bericht/Heatmap */
	color?: string;
}

/** Auswahl-Palette fuer Aktivitaets-Farben. */
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
	/** Ende als Epoch-ms; null = laeuft gerade */
	endTs: number | null;
	note: string;
	source: EntrySource;
	/**
	 * Nur fuer Abwesenheits-Eintraege: Tagesanteil (1 = ganzer Tag, 0.5 = halber Tag).
	 * Die Stunden werden als dayFraction * settings.hoursPerDay berechnet.
	 */
	dayFraction?: number;
}

/**
 * Ein Teammitglied im Chef-Modus: von dieser Person wird ein Monatsbericht
 * erwartet. Die Zuordnung eingehender Mails laeuft ueber `email`.
 */
export interface TeamMember {
	id: string;
	name: string;
	email: string;
}

export interface Settings {
	/** Erinnerungszeiten im Format "HH:MM" */
	reminderTimes: string[];
	bossEmail: string;
	senderName: string;
	/** Rundung in Stunden, z.B. 0.5 */
	rounding: number;
	autostart: boolean;
	/** Stunden eines vollen Arbeitstags (fuer Abwesenheits-Umrechnung) */
	hoursPerDay: number;
	/**
	 * Pause automatisch von der Tagesarbeitszeit abziehen (ab 4 h 15 min, ab 6 h
	 * 45 min) – wie LOGA es tut. Wirkt auf Tagessummen, Bericht und Auswertung;
	 * die erfassten Eintraege selbst bleiben unveraendert.
	 */
	breakDeduction: boolean;
	/** Regulaere Arbeitstage als Wochentagsnummern (0=So .. 6=Sa), Standard Mo–Fr */
	workdays: number[];
	/** Stichwort (lowercase) -> activityId fuer Kalender-Auto-Zuordnung */
	calendarKeywordMap: Record<string, string>;
	reportSubjectTemplate: string;
	/** Leerlauf-Erkennung: Minuten ohne Eingabe, ab denen gefragt wird (0 = aus) */
	idleThresholdMin: number;
	/** Auto-Stop-Warnung: Timer laeuft laenger als X Stunden (0 = aus) */
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
	/** Auswertung (Saldo, Stunden je Aktivitaet, Jahres-Heatmap) im Bericht zeigen */
	statsEnabled: boolean;
	/**
	 * Arbeitszeit-Check (ArbZG) im Bericht zeigen: Ausgleichszeitraum ueber 24
	 * Wochen samt Prognose, dazu Tagesgrenzen, Ruhezeit und Sonntagsarbeit.
	 */
	arbzgEnabled: boolean;
	/** Kurzer Hinweis auf der Tracking-Seite, wenn der Arbeitszeit-Check anschlaegt. */
	arbzgTrackingHint: boolean;
	/** Chef-Modus: Tab „Team" mit Auswertung der eingegangenen Berichts-Mails */
	bossMode: boolean;
	/** Team, von dem monatlich ein Bericht erwartet wird */
	team: TeamMember[];
	/** Betreff-Merkmal (Teilstring), an dem eine Berichts-Mail erkannt wird */
	teamSubjectFilter: string;
	/** Auch Unterordner des Posteingangs durchsuchen (Outlook-Regeln sortieren dorthin) */
	teamScanSubfolders: boolean;
	/** Anonyme Fehlermeldungen senden - NUR Fehler und Abstuerze, nicht die Tagesmeldung. */
	errorReportsEnabled: boolean;
	/** Vorabversionen beziehen. Liest auch der Rust-Teil aus der settings.json - wirkt erst nach Neustart. */
	betaUpdates: boolean;
	/** Zeitzone des Kontos als IANA-Kennung, z.B. "Europe/Berlin". */
	timeZone: string;
	/** Tag (YYYY-MM-DD), an dem zuletzt „aktiv" gemeldet wurde. */
	usageLastDay: string;
}

/** Standard-Betreff des Monatsberichts. */
export const DEFAULT_SUBJECT = "Stundenerfassung {month} – {name}";

/** Standard-Merkmal, an dem der Chef-Modus Berichts-Mails erkennt. */
export const DEFAULT_TEAM_SUBJECT_FILTER = "Stundenerfassung";

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
	team: [],
	teamSubjectFilter: DEFAULT_TEAM_SUBJECT_FILTER,
	teamScanSubfolders: true,
	errorReportsEnabled: true,
	betaUpdates: false,
	timeZone: "",
	usageLastDay: ""
};

/** Namen der eingebauten Zeilen, die immer im Bericht erscheinen. */
export const BUILTIN_OTHERS = "Others";
export const BUILTIN_ABSENCE = "Abwesenheiten";
