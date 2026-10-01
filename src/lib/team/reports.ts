// Den eigenen Bericht ans Team hochladen - zusätzlich zum gewohnten Versand,
// nicht statt ihm. Ein Fehler hier darf den Mail-Versand nicht verhindern.
import { fetchOwnTeamReport, uploadTeamReport } from "./api";
import {
	loadPendingTeamReports,
	loadTeamDevice,
	savePendingTeamReports,
	teamFileExists,
	type PendingTeamReport
} from "../store";
import { ApiError } from "../sync/api";
import { logWarn } from "../log";
import { createSerialQueue } from "../utils";
import type { MonthReport } from "../report/report";

/**
 * Was vom Bericht ans Team geht: Zeilen mit Stunden und die Summen. Die Kopie
 * liegt unverschlüsselt beim Server - Aktivitäten ohne Stunden (auch eigene,
 * die mit dem Team nichts zu tun haben) gehen nicht mit.
 */
export function teamReportPayload(report: MonthReport) {
	return {
		rows: report.rows
			.filter((r) => r.hours > 0)
			.map(({ name, hours, isAbsence }) => ({ name, hours, isAbsence })),
		total: report.total,
		workHours: report.workHours,
		absenceHours: report.absenceHours
	};
}

/** Vormerken und Nachholen lesen und schreiben dieselbe Liste - nie gleichzeitig. */
const withPendingLock = createSerialQueue();

/** Lohnt ein späterer Versuch? Eine Absage des Servers käme beim zweiten Mal genauso. */
const worthRetrying = (e: unknown): boolean => !(e instanceof ApiError) || e.retryable;

/**
 * Stiller No-Op ohne Team-Mitgliedschaft. Scheitert der Upload am Netz, wird
 * der Bericht vorgemerkt: der Monat gilt dann schon als gesendet, und sonst
 * fragte nichts mehr nach.
 */
export function uploadReportIfTeamMember(month: string, report: MonthReport): Promise<void> {
	return withPendingLock(async () => {
		try {
			const device = await loadTeamDevice();
			if (!device) return;
			const payload = teamReportPayload(report);
			const others = (await loadPendingTeamReports()).filter((p) => p.month !== month);
			try {
				await uploadTeamReport(device.serverUrl, device.token, month, payload);
				await savePendingTeamReports(others);
			} catch (e) {
				logWarn("Bericht konnte nicht ans Team hochgeladen werden", e);
				const again: PendingTeamReport[] = worthRetrying(e)
					? [{ month, teamMemberId: device.teamMemberId, report: payload }]
					: [];
				await savePendingTeamReports([...others, ...again]);
			}
		} catch (e) {
			logWarn("Bericht konnte nicht ans Team hochgeladen werden", e);
		}
	});
}

/** Vorgemerkte Berichte nachreichen - beim Start, sobald das Team erreichbar ist. */
export function retryTeamReportUploads(): Promise<void> {
	return withPendingLock(async () => {
		try {
			const pending = await loadPendingTeamReports();
			if (pending.length === 0) return;
			const device = await loadTeamDevice();
			// Da, aber nicht lesbar: später noch einmal, statt alles zu verwerfen.
			if (!device && (await teamFileExists())) return;
			const still: PendingTeamReport[] = [];
			for (const p of pending) {
				if (!device || p.teamMemberId !== device.teamMemberId) continue;
				try {
					await uploadTeamReport(device.serverUrl, device.token, p.month, p.report);
				} catch (e) {
					logWarn("Vorgemerkter Bericht konnte nicht ans Team hochgeladen werden", e);
					if (worthRetrying(e)) still.push(p);
				}
			}
			await savePendingTeamReports(still);
		} catch (e) {
			logWarn("Vorgemerkte Team-Berichte nicht nachgereicht", e);
		}
	});
}

/**
 * Ob der Bericht des Monats beim Team schon vorliegt. null heisst: nicht zu
 * klären - kein Team, Server nicht erreichbar oder zu alt für die Abfrage.
 */
export async function teamHasReport(month: string): Promise<boolean | null> {
	try {
		const device = await loadTeamDevice();
		if (!device) return null;
		const { submittedAt } = await fetchOwnTeamReport(device.serverUrl, device.token, month);
		return submittedAt !== null && submittedAt !== undefined;
	} catch (e) {
		logWarn("Stand des Berichts beim Team nicht abrufbar", e);
		return null;
	}
}
