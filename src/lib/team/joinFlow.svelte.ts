// Der Ablauf "einem Team über einen Einladungslink beitreten": Vorschau laden,
// Name/E-Mail eintragen, beitreten. Gemeinsam für den Desktop-Dialog
// (JoinTeamDialog.svelte) und die eigenständige Web-Route
// (routes/team/join/[code]) - siehe pairingFlow.svelte.ts für dasselbe Muster
// bei der Konto-Kopplung. Den Effekt, der die Vorschau bei einem neuen Link
// anstösst, hält jeder Aufrufer selbst: beide beobachten eine andere Quelle
// (teamJoin.pendingLink bzw. die Route).
import { completeTeamJoin, previewTeam } from "./join";
import type { TeamDeviceInfo } from "../store";
import { errorText } from "../log";

export class TeamJoinFlow {
	name = $state("");
	email = $state("");
	busy = $state(false);
	preview = $state<{ teamName: string } | "loading" | "error">("loading");
	/** Text der letzten fehlgeschlagenen Beitritts-Anfrage - null, solange keine lief oder sie gelang. */
	joinError = $state<string | null>(null);

	/** Nummer der jüngsten Vorschau-Anfrage: eine ältere, spät antwortende darf nicht überschreiben. */
	#previewRun = 0;

	/** Vorschau für einen (neuen) Link laden. */
	async loadPreview(serverUrl: string, code: string): Promise<void> {
		const run = ++this.#previewRun;
		this.preview = "loading";
		try {
			const result = await previewTeam(serverUrl, code);
			if (run === this.#previewRun) this.preview = result;
		} catch {
			if (run === this.#previewRun) this.preview = "error";
		}
	}

	/** Eingaben zurücksetzen - vor einem neuen Link bzw. nach Abbrechen. */
	reset(): void {
		this.name = "";
		this.email = "";
		this.joinError = null;
	}

	/** Beitreten. Liefert die Team-Infos bei Erfolg, sonst null (Grund in `joinError`). */
	async join(serverUrl: string, code: string): Promise<TeamDeviceInfo | null> {
		if (this.busy) return null;
		this.busy = true;
		this.joinError = null;
		try {
			return await completeTeamJoin(serverUrl, code, this.name.trim(), this.email.trim());
		} catch (e) {
			this.joinError = errorText(e);
			return null;
		} finally {
			this.busy = false;
		}
	}
}
