<script lang="ts">
	import * as Dialog from "$lib/components/ui/dialog";
	import { Button } from "$lib/components/ui/button";
	import { app } from "$lib/app.svelte";
	import { account } from "$lib/sync/account.svelte";
	import { monthLabel } from "$lib/time";
	import { sendReport } from "$lib/reportSend";
	import { capabilities } from "$lib/platform/env";
	import { watchers } from "$lib/watchers.svelte";
	import { toast } from "svelte-sonner";
	import MailIcon from "@lucide/svelte/icons/mail";

	// Einmal pro App-Lauf zeigen (nicht erneut aufpoppen nach Schließen).
	// Das "dismissed"-Flag liegt im watchers-Store, damit das Tray-Badge denselben
	// Zustand kennt (Badge = offene Aufmerksamkeits-Dialoge).
	let sending = $state(false);
	const month = $derived(app.pendingReportMonth);
	// Dev-Override: erzwungen anzeigen; Anzeige-Monat dann auf aktuellen Monat zurückfallen.
	const shownMonth = $derived(month ?? app.currentMonth);
	// Erst nach dem ersten Abgleich fragen. Ein gerade verknuepftes Geraet ist
	// lokal leer: die Eintraege des Vormonats kommen herein, welche Berichte
	// laengst raus sind steht aber in den Einstellungen - und die kommen mit
	// derselben Runde. Vorher waere die Frage nicht bloss laestig mitten im
	// Einrichten, sondern schlicht falsch: sie gilt einem Bericht, den jemand
	// vor Wochen von einem anderen Geraet aus geschickt hat.
	const synced = $derived(!account.linked || account.firstSyncDone);
	const open = $derived(
		watchers.forceReportReminder ||
			(!!month &&
				synced &&
				app.settings.reportReminderEnabled &&
				!watchers.reportReminderDismissed)
	);

	async function send() {
		if (!month) return;
		sending = true;
		try {
			const res = await sendReport(month);
			if (res.via === "outlook") {
				toast.success("Outlook-Entwurf geöffnet. Bitte prüfen und senden.");
			} else if (res.clipboard === null) {
				toast.warning("Die Tabelle konnte nicht kopiert werden.", {
					description: "Die Mail wurde stattdessen als einfache Liste geöffnet."
				});
			} else {
				// Wie es weitergeht, steht im Entwurf selbst.
				toast.success("Die Tabelle wurde kopiert.");
			}
			watchers.reportReminderDismissed = true;
			watchers.forceReportReminder = false;
		} catch (e) {
			toast.error(`Mail konnte nicht geöffnet werden: ${e}. Tipp: Tab „Bericht“ → „HTML kopieren“.`);
		} finally {
			sending = false;
		}
	}

	async function neverAgain() {
		if (month) await app.markReportSent(month);
		watchers.reportReminderDismissed = true;
		watchers.forceReportReminder = false;
	}
</script>

<Dialog.Root
	{open}
	onOpenChange={(v) => {
		if (!v) {
			watchers.reportReminderDismissed = true;
			watchers.forceReportReminder = false;
		}
	}}
>
	<Dialog.Content class="sm:max-w-md">
		<Dialog.Header>
			<Dialog.Title>Bericht noch nicht gesendet</Dialog.Title>
			<Dialog.Description>
				Der Stundenbericht für <strong>{monthLabel(shownMonth)}</strong> wurde noch nicht an die Vorgesetzten
				geschickt.
			</Dialog.Description>
		</Dialog.Header>
		<Dialog.Footer>
			<Button variant="ghost" onclick={neverAgain}>Nicht mehr erinnern</Button>
			<Button onclick={send} disabled={sending}>
				<MailIcon class="size-4" />
				{sending ? "Öffne…" : capabilities.outlook ? "Per Outlook senden" : "E-Mail vorbereiten"}
			</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
