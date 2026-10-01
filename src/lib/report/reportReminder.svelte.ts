// Die Erinnerung an den Monatsbericht: wann sie fällig ist und was ihre Knöpfe tun.
import { app } from "../app.svelte";
import { account } from "../sync/account.svelte";
import { watchers } from "../ui/watchers.svelte";
import { teamHasReport } from "../team/reports";
import { confirmReportSent } from "./reportSend";
import { logWarn } from "../log";

export class ReportReminder {
	/** Für welchen Monat die Frage ans Team beantwortet ist. */
	#teamChecked = $state<string | null>(null);
	/** Für welchen Monat sie gerade läuft - der Effekt im Dialog ruft mehrfach. */
	#checking: string | null = null;

	get month(): string | null {
		return app.pendingReportMonth;
	}

	// Erst nach dem ersten Abgleich fragen. Ein gerade verknüpftes Gerät ist
	// lokal leer: die Einträge des Vormonats kommen herein, welche Berichte
	// längst raus sind steht aber in den Einstellungen - und die kommen mit
	// derselben Runde. Vorher gälte die Frage einem Bericht, den jemand vor
	// Wochen von einem anderen Gerät aus geschickt hat.
	get synced(): boolean {
		return !account.linked || account.firstSyncDone;
	}

	/** Dialog und Tray-Badge fragen dasselbe - sonst leuchtet das Badge ohne Dialog dahinter. */
	get due(): boolean {
		const month = this.month;
		return (
			watchers.forceReportReminder ||
			(!!month &&
				this.#teamChecked === month &&
				this.synced &&
				app.settings.reportReminderEnabled &&
				!watchers.reportReminderDismissed)
		);
	}

	/**
	 * Im Team weiss der Server, ob der Bericht schon da ist - dann wird der Monat
	 * vermerkt statt nachgefragt. Lässt es sich nicht klären (kein Team, kein
	 * Netz, Vermerken gescheitert), fragt die Erinnerung wie ohne Team.
	 */
	async checkTeam(): Promise<void> {
		const month = this.month;
		if (!month || !this.synced || this.#teamChecked === month || this.#checking === month) return;
		this.#checking = month;
		try {
			if (await teamHasReport(month)) await app.markReportSent(month);
		} catch (e) {
			logWarn("Bericht liegt beim Team vor, liess sich aber nicht vermerken", e);
		} finally {
			this.#checking = null;
			this.#teamChecked = month;
		}
	}

	dismiss(): void {
		watchers.reportReminderDismissed = true;
		watchers.forceReportReminder = false;
	}

	/** "Schon gesendet". false = Vermerken gescheitert, die Erinnerung bleibt offen. */
	async confirmSent(): Promise<boolean> {
		try {
			if (this.month) await confirmReportSent(this.month);
		} catch (e) {
			logWarn("Bericht liess sich nicht als gesendet vermerken", e);
			return false;
		}
		this.dismiss();
		return true;
	}
}

export const reportReminder = new ReportReminder();
