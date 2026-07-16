export interface Activity {
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

export type EntrySource = "timer" | "manual" | "calendar";

export interface Entry {
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
	/** Monatliche Erinnerung, den Bericht an den Chef zu senden */
	reportReminderEnabled: boolean;
	/** Uhrzeit der Berichts-Erinnerung am letzten Werktag des Monats ("HH:MM") */
	reportReminderTime: string;
	/** Wie viele Werktage VOR dem letzten Werktag erinnert wird (0 = letzter Werktag) */
	reportReminderLeadDays: number;
	/** Monate (YYYY-MM), deren Bericht gesendet oder bewusst ignoriert wurde */
	reportSentMonths: string[];
	/** Auswertung (Saldo, Stunden je Aktivitaet, Jahres-Heatmap) im Bericht zeigen */
	statsEnabled: boolean;
}

export const defaultSettings: Settings = {
	reminderTimes: ["14:00"],
	bossEmail: "",
	senderName: "",
	rounding: 0.5,
	autostart: true,
	hoursPerDay: 7.5,
	workdays: [1, 2, 3, 4, 5],
	calendarKeywordMap: {},
	reportSubjectTemplate: "Stundenerfassung {month} – {name}",
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
	statsEnabled: false
};

/** Namen der eingebauten Zeilen, die immer im Bericht erscheinen. */
export const BUILTIN_OTHERS = "Others";
export const BUILTIN_ABSENCE = "Abwesenheiten";
