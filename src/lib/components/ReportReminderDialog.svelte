<script lang="ts">
	import * as Dialog from "$lib/components/ui/dialog";
	import { Button } from "$lib/components/ui/button";
	import { app } from "$lib/app.svelte";
	import { monthLabel } from "$lib/time";
	import { sendReport } from "$lib/reportSend";
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
	const open = $derived(
		watchers.forceReportReminder ||
			(!!month && app.settings.reportReminderEnabled && !watchers.reportReminderDismissed)
	);

	async function send() {
		if (!month) return;
		sending = true;
		try {
			await sendReport(month);
			toast.success("Outlook-Entwurf geöffnet. Bitte prüfen und senden.");
			watchers.reportReminderDismissed = true;
			watchers.forceReportReminder = false;
		} catch (e) {
			toast.error(`Outlook-Entwurf fehlgeschlagen: ${e}. Tipp: Tab „Bericht“ → „HTML kopieren“.`);
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
				Der Stundenbericht für <strong>{monthLabel(shownMonth)}</strong> wurde noch nicht an den Chef
				geschickt.
			</Dialog.Description>
		</Dialog.Header>
		<Dialog.Footer>
			<Button variant="ghost" onclick={neverAgain}>Nicht mehr erinnern</Button>
			<Button onclick={send} disabled={sending}>
				<MailIcon class="size-4" />
				{sending ? "Öffne…" : "Per Outlook senden"}
			</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
