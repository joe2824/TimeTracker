<script lang="ts">
	// Beim ersten Abgleich nach einer Kopplung gewinnt bei einem Konflikt die
	// neuere Fassung - auch gegen eine eigene, noch nicht hochgeladene Änderung.
	//
	// Das stand bisher nur als Zeile im Konto-Bereich. Dort schaut niemand nach,
	// und wer seine Zeiten vermisst, sucht zuerst woanders. Deshalb hier, wo es
	// passiert - und mit dem Weg zurück, nicht nur mit der Zahl.
	import * as Dialog from "$lib/components/ui/dialog";
	import { Button } from "$lib/components/ui/button";
	import { account } from "$lib/sync/account.svelte";
	import { latestSnapshot, restoreSnapshot } from "$lib/report/backup";
	import { fmtDateHuman } from "$lib/time/time";
	import { errorText } from "$lib/log";
	import { toast } from "svelte-sonner";

	let seen = $state(false);
	let busy = $state(false);
	let snapshot = $state<{ name: string; at: number } | null>(null);

	const open = $derived(account.lostEdits > 0 && !seen);

	$effect(() => {
		if (open && !snapshot) void latestSnapshot().then((v) => (snapshot = v));
	});

	function dismiss() {
		seen = true;
	}

	async function restore() {
		if (!snapshot) return;
		busy = true;
		try {
			const r = await restoreSnapshot(snapshot.name);
			seen = true;
			account.lostEdits = 0;
			toast.success(`Sicherung eingespielt: ${r.restoredEntries} Einträge.`);
		} catch (e) {
			toast.error(`Einspielen fehlgeschlagen: ${errorText(e)}`);
		} finally {
			busy = false;
		}
	}
</script>

<Dialog.Root
	{open}
	onOpenChange={(o) => {
		if (!o && !busy) dismiss();
	}}
>
	<Dialog.Content class="sm:max-w-md">
		<Dialog.Header>
			<Dialog.Title>Einige eigene Änderungen wurden ersetzt</Dialog.Title>
			<Dialog.Description>
				{account.lostEdits}
				{account.lostEdits === 1 ? "Änderung" : "Änderungen"} von diesem Gerät waren noch nicht
				hochgeladen, als ein anderes Gerät dieselben Einträge neuer geändert hat. Dabei gilt die
				neuere Fassung.
			</Dialog.Description>
		</Dialog.Header>

		{#if snapshot}
			<p class="text-sm">
				Der Stand von vor der Kopplung liegt als Sicherung vom
				<strong>{fmtDateHuman(snapshot.at)}</strong>. Einspielen ergänzt fehlende Einträge und
				lässt die neueren stehen.
			</p>
		{:else}
			<p class="text-muted-foreground text-sm">
				Für diesen Zeitpunkt liegt keine Sicherung vor – es gab beim Koppeln nichts zu sichern.
			</p>
		{/if}

		<Dialog.Footer>
			<Button variant="outline" disabled={busy} onclick={dismiss}>Alles gut</Button>
			{#if snapshot}
				<Button disabled={busy} onclick={restore}>
					{busy ? "Wird eingespielt…" : "Sicherung einspielen"}
				</Button>
			{/if}
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
