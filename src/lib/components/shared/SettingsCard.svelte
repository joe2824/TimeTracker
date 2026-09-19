<script lang="ts">
	// Einheitlicher Rahmen für eine Gruppe von Einstellungen - vor allem, damit
	// die Trennlinien zwischen den Zeilen überall gleich sitzen.
	import type { Snippet } from "svelte";
	import * as Card from "$lib/components/ui/card";
	import SavedHint from "$lib/components/shared/SavedHint.svelte";
	import { cn } from "$lib/utils";

	interface Props {
		title: string;
		/** erklärende Zeile unter dem Titel */
		description?: string;
		/** Zeitpunkt des letzten Speicherns; weglassen, wenn die Card nichts automatisch speichert */
		savedAt?: number;
		/** false = schlichter Abstand statt Trennlinien (für Fliesstext-Karten) */
		divided?: boolean;
		class?: string;
		/** Element im Kopf rechts neben dem Titel, z.B. ein Schalter für die ganze Karte */
		action?: Snippet;
		children: Snippet;
	}
	let {
		title,
		description,
		savedAt,
		divided = true,
		class: className,
		action,
		children
	}: Props = $props();
</script>

<Card.Root class={className}>
	<Card.Header>
		<Card.Title>{title}</Card.Title>
		{#if description}
			<Card.Description>{description}</Card.Description>
		{/if}
		{#if savedAt !== undefined || action}
			<Card.Action class="flex items-center gap-2">
				{#if savedAt !== undefined}<SavedHint at={savedAt} />{/if}
				{#if action}{@render action()}{/if}
			</Card.Action>
		{/if}
	</Card.Header>
	<!-- divide-y trifft die direkten Kinder: jede Zeile bringt ihren Abstand selbst
	     mit, oben und unten schliesst die Card bündig ab. -->
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
