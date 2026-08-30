<script lang="ts">
	// Eine Kennzahl: Beschriftung, Wert, Einordnung. Vorher standen die Zahlen in
	// Auswertung und Arbeitszeit-Check als lose Bloecke mit `gap-8` nebeneinander –
	// bei fuenf Stueck war weder zu sehen, was zusammengehoert, noch passte die
	// Reihe auf ein schmales Fenster.
	import type { Snippet } from "svelte";
	import { cn } from "$lib/utils";

	interface Props {
		label: string;
		/** Zeile unter dem Wert: Bezugsgroesse, Einheit, Einordnung. */
		hint?: string;
		/** true = der Wert selbst ist die schlechte Nachricht. */
		alarm?: boolean;
		/** Zusatzklassen fuer den Wert, z.B. gedaempft bei "nichts passiert". */
		valueClass?: string;
		class?: string;
		/** Der Wert – als Snippet, weil dort auch ein Datum oder "—" stehen kann. */
		children: Snippet;
		/** Ersetzt die Hinweiszeile, wenn sie mehr als schlichten Text braucht. */
		hintSlot?: Snippet;
	}
	let {
		label,
		hint,
		alarm = false,
		valueClass,
		class: className,
		children,
		hintSlot
	}: Props = $props();
</script>

<div class={cn("bg-muted/40 rounded-lg px-3 py-2.5", className)}>
	<div class="text-muted-foreground text-xs">{label}</div>
	<!-- tabular-nums: sonst tanzen die Werte beim Ticken in der Breite. -->
	<div class={cn("text-2xl leading-tight tabular-nums", alarm && "text-destructive", valueClass)}>
		{@render children()}
	</div>
	{#if hintSlot}
		{@render hintSlot()}
	{:else if hint}
		<div class="text-muted-foreground text-xs">{hint}</div>
	{/if}
</div>
