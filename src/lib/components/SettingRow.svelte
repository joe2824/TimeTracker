<script lang="ts">
	// Eine Einstellungs-Zeile: links Titel + Erklaerung, rechts das Bedienelement.
	// EIN Rhythmus fuer alle Einstellungen – vorher stand ein zweispaltiges Grid mit
	// ueberlangen Labels neben Schalter-Zeilen, die es genau andersherum machten.
	import type { Snippet } from "svelte";
	import { cn } from "$lib/utils";
	import { Label } from "$lib/components/ui/label";

	interface Props {
		/** id des Bedienelements; verknuepft Label und Control */
		id: string;
		title: string;
		/** erklaerende Zeile darunter – hier gehoeren Hinweise wie "0 = aus" hin */
		description?: string;
		/** das Bedienelement rechts */
		control: Snippet;
		/** Zusatzklassen fuer die Zeile, z.B. eine Trennlinie darueber */
		class?: string;
	}
	let { id, title, description, control, class: className }: Props = $props();
</script>

<div class={cn("flex items-center justify-between gap-4", className)}>
	<Label for={id} class="flex flex-col items-start gap-1">
		<span class="text-sm font-medium">{title}</span>
		{#if description}
			<span class="text-muted-foreground text-xs font-normal">{description}</span>
		{/if}
	</Label>
	<div class="shrink-0">
		{@render control()}
	</div>
</div>
