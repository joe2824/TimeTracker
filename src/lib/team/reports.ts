// Den eigenen Bericht ans Team hochladen - zusätzlich zum gewohnten Versand,
// nicht statt ihm. Ein Fehler hier darf den Mail-Versand nicht verhindern.
import { fetchOwnTeamReport, uploadTeamReport } from "./api";
import { loadTeamDevice } from "../store";
import { logWarn } from "../log";
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

/** Stiller No-Op ohne Team-Mitgliedschaft. */
export async function uploadReportIfTeamMember(month: string, report: MonthReport): Promise<void> {
	try {
		const device = await loadTeamDevice();
		if (!device) return;
		await uploadTeamReport(device.serverUrl, device.token, month, teamReportPayload(report));
	} catch (e) {
		logWarn("Bericht konnte nicht ans Team hochgeladen werden", e);
	}
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
