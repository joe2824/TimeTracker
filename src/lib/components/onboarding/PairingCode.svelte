<script lang="ts">
	import { Button } from "$lib/components/ui/button";
	import { toast } from "svelte-sonner";
	import { formatPairingCode } from "$lib/crypto/vault";
	import CopyIcon from "@lucide/svelte/icons/copy";
	import CheckIcon from "@lucide/svelte/icons/check";
	import ExternalLinkIcon from "@lucide/svelte/icons/external-link";
	import { pairLink } from "$lib/platform/deeplink";
	import { isTauri } from "$lib/platform/env";

	let { code, onCancel }: { code: string; onCancel?: () => void } = $props();

	let kopiert = $state(false);

	async function kopieren() {
		try {
			await navigator.clipboard.writeText(formatPairingCode(code));
			kopiert = true;
			// Zuruecksetzen, damit der Knopf nicht dauerhaft "erledigt" zeigt.
			setTimeout(() => (kopiert = false), 2000);
		} catch {
			toast.error("Kopieren nicht möglich – bitte abschreiben.");
		}
	}
</script>

<div class="space-y-3">
	<div class="bg-muted flex flex-col items-center gap-2 rounded-lg p-4">
		<!-- In Gruppen und weit gesperrt: abgetippt wird das von einem Bildschirm
		     auf einen anderen, und dabei verrutscht man in einer langen Kette. -->
		<p class="font-mono text-2xl font-semibold tracking-[0.25em] select-all sm:text-3xl">
			{formatPairingCode(code)}
		</p>
		<Button variant="ghost" size="sm" onclick={kopieren}>
			{#if kopiert}
				<CheckIcon class="size-4" /> Kopiert
			{:else}
				<CopyIcon class="size-4" /> Kopieren
			{/if}
		</Button>
	</div>

	{#if !isTauri()}
		<!-- Wer die Anwendung auf demselben Rechner hat, muss nichts abtippen: der
		     Link oeffnet sie mit dem Code im Feld. Bestaetigen bleibt eine
		     Handlung - ein Link, der von allein koppelt, waere ein Kontozugang in
		     der Browser-Chronik. -->
		<Button variant="outline" size="sm" class="w-full" href={pairLink(code)}>
			<ExternalLinkIcon class="size-4" /> In der App öffnen
		</Button>
	{/if}

	<p class="text-muted-foreground text-center text-xs">
		Sonst auf dem Gerät eintragen, das <strong>schon an dem Konto hängt</strong> –
		unter Einstellungen → Konto. Gilt zehn Minuten.
	</p>

	{#if onCancel}
		<Button variant="ghost" size="sm" class="w-full" onclick={onCancel}>Abbrechen</Button>
	{/if}
</div>
