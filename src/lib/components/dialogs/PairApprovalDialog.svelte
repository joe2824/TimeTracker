<script lang="ts">
	// Der Dialog, der aufgeht, wenn ein „In der App öffnen" aus dem Browser
	// ankommt. Er gehört ins Hauptfenster, nicht in die Einstellungen: der Link
	// trifft die App irgendwo, und niemand sucht danach von allein.
	//
	// Der Code steht bewusst gross darin. Ein Dialog, der nur „Bestätigen" zeigt,
	// liesse sich von einer beliebigen Seite auslösen - `timetracker://pair/...`
	// darf jeder bauen. Erst der Vergleich mit dem Code im eigenen Browser
	// unterscheidet „mein Gerät" von „untergeschoben".
	import * as Dialog from "$lib/components/ui/dialog";
	import { Button } from "$lib/components/ui/button";
	import { account } from "$lib/sync/account.svelte";
	import { formatPairingCode, isPairingCode, normalizePairingCode } from "$lib/crypto/vault";
	import { errorText } from "$lib/log";
	import { toast } from "svelte-sonner";

	let busy = $state(false);

	const code = $derived(normalizePairingCode(account.pairCodeFromLink));
	const open = $derived(isPairingCode(code));
	// Freigeben kann nur, wer selbst am Konto haengt: der Vault-Schluessel wird
	// hier fuer das neue Geraet verpackt. Ohne das lief der Klick in „Das Konto
	// ist nicht entsperrt" - richtig, aber am eigentlichen Grund vorbei.
	const canApprove = $derived(account.linked);

	function dismiss() {
		account.pairCodeFromLink = "";
	}

	async function approve() {
		busy = true;
		try {
			const label = await account.approvePairing(code);
			dismiss();
			toast.success(`„${label}" ist jetzt verknüpft.`);
		} catch (e) {
			toast.error(`Code konnte nicht bestätigt werden: ${errorText(e)}`);
		} finally {
			busy = false;
		}
	}
</script>

<Dialog.Root
	{open}
	onOpenChange={(o) => {
		// Nicht mitten im Freigeben wegklicken lassen - der Aufruf läuft weiter,
		// und das Ergebnis hätte dann kein Fenster mehr.
		if (!o && !busy) dismiss();
	}}
>
	<Dialog.Content class="sm:max-w-md">
		<Dialog.Header>
			<Dialog.Title>
				{canApprove ? "Gerät mit deinem Konto verbinden?" : "Dieses Gerät hat noch kein Konto"}
			</Dialog.Title>
			<Dialog.Description>
				{#if canApprove}
					Ein Browser möchte gekoppelt werden. Vergleiche den Code mit dem, der dort steht –
					stimmt er nicht überein, brich ab.
				{:else}
					Freigeben kann nur ein Gerät, das selbst schon an dem Konto hängt. Richte diese App
					zuerst unter Einstellungen → Konto ein, dann klappt der Link.
				{/if}
			</Dialog.Description>
		</Dialog.Header>

		{#if canApprove}
			<div class="bg-muted/40 rounded-lg border py-4 text-center">
				<span class="font-mono text-xl font-semibold tracking-[0.2em]">
					{formatPairingCode(code)}
				</span>
			</div>
		{/if}

		<Dialog.Footer>
			<Button variant="outline" disabled={busy} onclick={dismiss}>
				{canApprove ? "Abbrechen" : "Schliessen"}
			</Button>
			{#if canApprove}
				<Button disabled={busy} onclick={approve}>
					{busy ? "Wird verbunden…" : "Verbinden"}
				</Button>
			{/if}
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
