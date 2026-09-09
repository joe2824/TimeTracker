// Reaktiver Zustand rund um die Team-Mitgliedschaft dieses Geräts.
class TeamJoinState {
	/** Ein Team-Beitritts-Link ist angekommen und wartet auf Bestätigung. */
	pendingLink = $state<{ code: string; serverUrl: string } | null>(null);
}

export const teamJoin = new TeamJoinState();
