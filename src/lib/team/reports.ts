// Den eigenen Bericht ans Team hochladen - zusätzlich zum gewohnten Versand,
// nicht statt ihm. Ein Fehler hier darf den Mail-Versand nicht verhindern.
import { uploadTeamReport } from "./api";
import { loadTeamDevice } from "../store";
import { logWarn } from "../log";

/** Stiller No-Op ohne Team-Mitgliedschaft. */
export async function uploadReportIfTeamMember(month: string, report: unknown): Promise<void> {
	const device = await loadTeamDevice();
	if (!device) return;
	try {
		await uploadTeamReport(device.serverUrl, device.token, month, report);
	} catch (e) {
		logWarn("Bericht konnte nicht ans Team hochgeladen werden", e);
	}
}
