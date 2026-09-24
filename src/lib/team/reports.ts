// Den eigenen Bericht ans Team hochladen - zusätzlich zum gewohnten Versand,
// nicht statt ihm. Ein Fehler hier darf den Mail-Versand nicht verhindern.
import { uploadTeamReport } from "./api";
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
