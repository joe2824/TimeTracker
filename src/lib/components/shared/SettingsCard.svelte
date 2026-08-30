<script lang="ts">
	// Einheitlicher Rahmen fuer eine Gruppe von Einstellungen. Nimmt der Seite die
	// Wiederholung aus Card.Root/Header/Content ab und sorgt vor allem dafuer, dass
	// die Trennlinien zwischen den Zeilen ueberall gleich sitzen - vorher stand an
	// jeder zweiten Zeile ein handgesetztes "border-t pt-3", mal mit, mal ohne.
	import type { Snippet } from "svelte";
	import * as Card from "$lib/components/ui/card";
	import SavedHint from "$lib/components/shared/SavedHint.svelte";
	import { cn } from "$lib/utils";

	interface Props {
		title: string;
		/** erklaerende Zeile unter dem Titel */
		description?: string;
		/** Zeitpunkt des letzten Speicherns; weglassen, wenn die Card nichts automatisch speichert */
		savedAt?: number;
		/** false = schlichter Abstand statt Trennlinien (fuer Fliesstext-Karten) */
		divided?: boolean;
		class?: string;
		children: Snippet;
	}
	let {
		title,
		description,
		savedAt,
		divided = true,
		class: className,
		children
	}: Props = $props();
</script>

<Card.Root class={className}>
	<Card.Header>
		<Card.Title>{title}</Card.Title>
		{#if description}
			<Card.Description>{description}</Card.Description>
		{/if}
		{#if savedAt !== undefined}
			<Card.Action><SavedHint at={savedAt} /></Card.Action>
		{/if}
	</Card.Header>
	<!-- divide-y trifft die direkten Kinder: jede Zeile bringt ihren Abstand selbst
	     mit, oben und unten schliesst die Card buendig ab. -->
	<Card.Content
		class={cn(
			divided
				? "divide-y *:py-3.5 [&>*:first-child]:pt-0 [&>*:last-child]:pb-0"
				: "space-y-3"
		)}
	>
		{@render children()}
	</Card.Content>
</Card.Root>
