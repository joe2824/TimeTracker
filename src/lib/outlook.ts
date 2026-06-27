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

/** Fallback: oeffnet den Standard-Mailclient via mailto (ohne HTML-Tabelle). */
export function mailtoFallback(to: string, subject: string, bodyText: string): string {
	const params = new URLSearchParams({ subject, body: bodyText });
	return `mailto:${encodeURIComponent(to)}?${params.toString()}`;
}
