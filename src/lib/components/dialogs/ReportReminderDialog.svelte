<script lang="ts">
	import * as Dialog from "$lib/components/ui/dialog";
	import { Button } from "$lib/components/ui/button";
	import { app } from "$lib/app.svelte";
	import { monthLabel } from "$lib/time/time";
	import { sendReport } from "$lib/report/reportSend";
	import { reportReminder } from "$lib/report/reportReminder.svelte";
	import { capabilities } from "$lib/platform/env";
	import { toast } from "svelte-sonner";
	import MailIcon from "@lucide/svelte/icons/mail";

	// Einmal pro App-Lauf zeigen (nicht erneut aufpoppen nach Schließen).
	let sending = $state(false);
	const month = $derived(reportReminder.month);
	// Dev-Override: erzwungen anzeigen; Anzeige-Monat dann auf aktuellen Monat zurückfallen.
	const shownMonth = $derived(month ?? app.currentMonth);
	$effect(() => {
		// Gelesen, damit der Effekt bei neuem Monat oder fertigem Abgleich erneut läuft.
		if (reportReminder.month && reportReminder.synced) void reportReminder.checkTeam();
	});
	const open = $derived(reportReminder.due);

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
			reportReminder.dismiss();
		} catch (e) {
			toast.error(`Mail konnte nicht geöffnet werden: ${e}. Tipp: Tab „Bericht“ → „HTML kopieren“.`);
		} finally {
			sending = false;
		}
	}

	async function alreadySent() {
		if (!(await reportReminder.confirmSent())) {
			toast.error("Das konnte nicht gespeichert werden. Bitte noch einmal versuchen.");
		}
	}
</script>

<Dialog.Root
	{open}
	onOpenChange={(v) => {
		if (!v) reportReminder.dismiss();
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
			<Button variant="ghost" onclick={alreadySent}>Schon gesendet</Button>
			<Button onclick={send} disabled={sending}>
				<MailIcon class="size-4" />
				{sending ? "Öffne…" : capabilities.outlook ? "Per Outlook senden" : "E-Mail vorbereiten"}
			</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
