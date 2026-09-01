import { invoke } from "@tauri-apps/api/core";
import { errorText, logError } from "./log";

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

/** Der Briefumschlag einer Mail aus dem Posteingang (Chef-Modus). */
export interface OutlookMail {
	subject: string;
	senderName: string;
	/** SMTP-Adresse; bei Exchange-Absendern aufgeloest (siehe outlook.ps1) */
	senderEmail: string;
	/** ISO-Zeitstempel des Empfangs */
	received: string;
	folder: string;
}

/**
 * Liest die Briefumschlaege des Posteingangs im Zeitraum (ISO-Datum, inkl.
 * Grenzen), gefiltert auf einen Betreff-Teilstring. Reiner Lesezugriff.
 */
export async function readOutlookMails(
	start: string,
	end: string,
	subjectFilter: string,
	subfolders: boolean,
	max = 300
): Promise<OutlookMail[]> {
	const res = await invoke<OutlookMail[]>("read_outlook_mails", {
		start,
		end,
		subjectFilter,
		subfolders,
		max
	});
	return Array.isArray(res) ? res : [];
}

/** Fallback: oeffnet den Standard-Mailclient via mailto (ohne HTML-Tabelle). */
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
			return "Du nutzt das neue Outlook (Store-App). Für den direkten Entwurf wird das klassische Outlook benötigt – nutze bitte den Mail-Fallback.";
		}
		if (info.classicComRegistered && !info.classicProfile) {
			return "Im klassischen Outlook ist kein E-Mail-Profil eingerichtet – bitte nutze den Mail-Fallback.";
		}
		return "Klassisches Outlook (COM) ist nicht verfügbar – nutze bitte den Mail-Fallback.";
	}
	return raw || "Outlook konnte nicht angesprochen werden.";
}

/**
 * Einen fehlgeschlagenen Outlook-Aufruf protokollieren und die Meldung fuer den
 * Bildschirm zurueckgeben.
 */
export async function reportOutlookError(context: string, err: unknown): Promise<string> {
	const info = await detectOutlook().catch(() => null);
	logError(context, { error: errorText(err), outlook: info });
	return explainOutlookError(err, info);
}
