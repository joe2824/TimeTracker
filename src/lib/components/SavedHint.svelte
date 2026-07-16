<script lang="ts">
	// Kurzes "Gespeichert" je Card. Die Einstellungen speichern automatisch; ohne
	// Rueckmeldung waere nicht erkennbar, DASS etwas passiert ist.
	import { fade } from "svelte/transition";
	import CheckIcon from "@lucide/svelte/icons/check";

	interface Props {
		/** Zeitpunkt des letzten Speicherns (Date.now()); 0 = noch nie */
		at: number;
	}
	let { at }: Props = $props();

	let visible = $state(false);

	$effect(() => {
		if (!at) return;
		visible = true;
		const t = setTimeout(() => (visible = false), 2000);
		return () => clearTimeout(t);
	});
</script>

{#if visible}
	<span
		class="text-muted-foreground flex items-center gap-1 text-xs"
		transition:fade={{ duration: 150 }}
	>
		<CheckIcon class="size-3.5" /> Gespeichert
	</span>
{/if}
