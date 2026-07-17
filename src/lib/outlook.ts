import { invoke } from "@tauri-apps/api/core";

export interface CalendarEvent {
	subject: string;
	start: string; // ISO
	end: string; // ISO
	allDay: boolean;
	categories: string;
	busyStatus: number; // 0 frei,1 vorbehalt,2 gebucht,3 abwesend,4 woanders
	durationMinutes: number;
}

/**
 * Erstellt einen Outlook-Entwurf (per COM) und zeigt ihn an. Sendet NICHT automatisch.
 * Wirft bei Fehler (z.B. kein klassisches Outlook) - der Aufrufer bietet dann den Fallback an.
 */
export async function createOutlookDraft(
	to: string,
	subject: string,
	htmlBody: string
): Promise<string> {
	return invoke<string>("create_outlook_draft", { to, subject, htmlBody });
}

/** Liest Kalendereintraege im Zeitraum (ISO-Datum, inkl. Grenzen). */
export async function readOutlookCalendar(start: string, end: string): Promise<CalendarEvent[]> {
	const res = await invoke<CalendarEvent[]>("read_outlook_calendar", { start, end });
	return Array.isArray(res) ? res : [];
}

/**
 * Fallback: oeffnet den Standard-Mailclient via mailto (ohne HTML-Tabelle).
 *
 * Nicht URLSearchParams: das kodiert Leerzeichen als "+" (Formular-Kodierung),
 * mailto nimmt "+" laut RFC 6068 aber woertlich. Der Betreff kam damit als
 * "Stundenerfassung+Juli+2026+–+Joel+Klein" bei den Vorgesetzten an – und zwar
 * genau dann, wenn kein klassisches Outlook da ist, also im Fall, fuer den es
 * diesen Fallback ueberhaupt gibt.
 */
export function mailtoFallback(to: string, subject: string, bodyText: string): string {
	const q = `subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(bodyText)}`;
	return `mailto:${encodeURIComponent(to)}?${q}`;
}

export interface OutlookInfo {
	/** Klassisches Outlook ist als COM-Server registriert (installiert). */
	classicComRegistered: boolean;
	/** Ein klassisches MAPI-Profil ist eingerichtet. */
	classicProfile: boolean;
	/** Das neue Outlook (Store-App) ist installiert. */
	newOutlookInstalled: boolean;
	/** Anwender hat auf das neue Outlook umgeschaltet (UseNewOutlook=1). */
	prefersNewOutlook: boolean;
	/** COM-Integration (Entwurf/Kalender) sollte funktionieren. */
	comUsable: boolean;
}

/** Ermittelt (ohne COM-Start), welche Outlook-Variante verfuegbar/aktiv ist. */
export async function detectOutlook(): Promise<OutlookInfo> {
	return invoke<OutlookInfo>("detect_outlook");
}

/**
 * Baut aus einem fehlgeschlagenen COM-Aufruf eine verstaendliche Meldung.
 * Erklaert speziell den Fall "nur neues Outlook, kein klassisches Profil".
 */
export function explainOutlookError(err: unknown, info?: OutlookInfo | null): string {
	const raw = String(err ?? "").trim();
	if (info && !info.comUsable) {
		if (info.newOutlookInstalled && !info.classicComRegistered) {
			return "Du nutzt das neue Outlook (Store-App). Für den Outlook-Entwurf/Kalender wird das klassische Outlook benötigt – dafür steht nur der Mail-Fallback zur Verfügung.";
		}
		if (info.classicComRegistered && !info.classicProfile) {
			return "Im klassischen Outlook ist kein E-Mail-Profil eingerichtet. Bitte einmal das klassische Outlook einrichten – bis dahin greift der Mail-Fallback.";
		}
	}
	return raw || "Outlook konnte nicht angesprochen werden.";
}
