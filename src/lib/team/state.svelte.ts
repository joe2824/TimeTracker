// Reaktiver Zustand rund um die Team-Mitgliedschaft dieses Geräts.
import type { TeamDeviceInfo } from "../store";

class TeamJoinState {
	/** Ein Team-Beitritts-Link ist angekommen und wartet auf Bestätigung. */
	pendingLink = $state<{ code: string; serverUrl: string } | null>(null);
	/**
	 * Dieses Gerät als Team-Mitglied, oder null - zentral hier statt in jeder
	 * Komponente einzeln aus team.json gelesen, damit ein Beitritt über den
	 * Dialog (oder ein Verlassen) sofort überall sichtbar wird. bits-ui baut
	 * alle Einstellungs-Tabs beim Start mit auf; ein lokales onMount-Laden in
	 * ReportTab sähe einen späteren Beitritt sonst nie.
	 */
	device = $state<TeamDeviceInfo | null>(null);
}

export const teamJoin = new TeamJoinState();
