// Der Ablauf "einem Team über einen Einladungslink beitreten": Vorschau laden,
// Name/E-Mail eintragen, beitreten. Gemeinsam für den Desktop-Dialog
// (JoinTeamDialog.svelte) und die eigenständige Web-Route
// (routes/team/join/[code]) - siehe pairingFlow.svelte.ts für dasselbe Muster
// bei der Konto-Kopplung. Den Effekt, der die Vorschau bei einem neuen Link
// anstösst, hält jeder Aufrufer selbst: beide beobachten eine andere Quelle
// (teamJoin.pendingLink bzw. die Route).
import { completeTeamJoin } from "./join";
import { previewTeamInvite } from "./api";
import { LinkPreview, type LinkPreviewState } from "./linkPreview.svelte";
import { loadTeamDevice, type TeamDeviceInfo } from "../store";
import { errorText } from "../log";
import { cleanEmail } from "$shared/email";
import { normalizeServerUrl } from "../sync/api";

export class TeamJoinFlow {
	name = $state("");
	email = $state("");
	busy = $state(false);
	#link = new LinkPreview(previewTeamInvite);
	/** Text der letzten fehlgeschlagenen Beitritts-Anfrage - null, solange keine lief oder sie gelang. */
	joinError = $state<string | null>(null);
	/** Die Mitgliedschaft, die ein Beitritt ersetzen würde - der Dialog warnt davor. */
	existing = $state<TeamDeviceInfo | null>(null);

	get preview(): LinkPreviewState {
		return this.#link.state;
	}

	/** Eine eingetragene, aber unbrauchbare Adresse würfe der Server still weg - dann fehlte die Erinnerung. */
	get emailInvalid(): boolean {
		return this.email.trim() !== "" && cleanEmail(this.email) === null;
	}

	/**
	 * Der Link gehört zu dem Team, in dem dieses Gerät schon ist. Ein erneuter
	 * Beitritt legte beim Server ein neues Mitglied an und gäbe das alte auf -
	 * der Chef sähe den laufenden Monat dann wieder als "kein Bericht".
	 * Erkannt an Server und Teamname: die Vorschau nennt keine Team-Id.
	 */
	sameTeam(serverUrl: string): boolean {
		const e = this.existing;
		const preview = this.preview;
		if (!e || typeof preview !== "object") return false;
		return normalizeServerUrl(e.serverUrl) === normalizeServerUrl(serverUrl) && e.teamName === preview.teamName;
	}

	/** Beitritt möglich - auch nicht zu dem Team, in dem das Gerät schon ist (siehe sameTeam). */
	canJoinAt(serverUrl: string): boolean {
		return !this.busy && this.name.trim() !== "" && !this.emailInvalid && !this.sameTeam(serverUrl);
	}

	/** Vorschau für einen (neuen) Link laden. */
	async loadPreview(serverUrl: string, code: string): Promise<void> {
		const { run, done } = this.#link.load(serverUrl, code);
		void loadTeamDevice()
			.then((d) => {
				if (this.#link.isCurrent(run)) this.existing = d;
			})
			.catch(() => {});
		await done;
	}

	/** Eingaben zurücksetzen - vor einem neuen Link bzw. nach Abbrechen. */
	reset(): void {
		this.name = "";
		this.email = "";
		this.joinError = null;
	}

	/**
	 * Beitreten. Liefert die Team-Infos bei Erfolg, sonst null - `joinError` ist
	 * nur gesetzt, wenn die Anfrage scheiterte, nicht wenn canJoinAt() sie verhinderte.
	 */
	async join(serverUrl: string, code: string): Promise<TeamDeviceInfo | null> {
		if (!this.canJoinAt(serverUrl)) return null;
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
