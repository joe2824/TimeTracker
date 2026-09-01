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

	let copied = $state(false);

	async function copy() {
		try {
			await navigator.clipboard.writeText(formatPairingCode(code));
			copied = true;
			toast.success("Kopplungscode kopiert.");
			setTimeout(() => (copied = false), 2500);
		} catch {
			toast.error("Kopieren nicht möglich – bitte manuell kopieren.");
		}
	}
</script>

<div class="space-y-3">
	<button
		type="button"
		onclick={copy}
		class="bg-muted hover:bg-muted/80 active:scale-[0.99] group relative flex w-full cursor-pointer flex-col items-center gap-2 rounded-xl p-4 transition-all outline-none focus-visible:ring-2 focus-visible:ring-ring/50 border border-transparent hover:border-primary/20 shadow-sm"
		title="Klicken zum Kopieren"
	>
		<!-- In Gruppen und weit gesperrt: abgetippt wird das von einem Bildschirm
		     auf einen anderen, und dabei verrutscht man in einer langen Kette. -->
		<p class="font-mono text-2xl font-semibold tracking-[0.25em] text-primary sm:text-3xl select-all">
			{formatPairingCode(code)}
		</p>
		<div class="inline-flex items-center gap-1.5 text-xs text-muted-foreground group-hover:text-foreground transition-colors font-medium">
			{#if copied}
				<CheckIcon class="size-3.5 text-emerald-500" />
				<span class="text-emerald-600 dark:text-emerald-400 font-medium">In die Zwischenablage kopiert!</span>
			{:else}
				<CopyIcon class="size-3.5" />
				<span>Klicken zum Kopieren</span>
			{/if}
		</div>
	</button>

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
