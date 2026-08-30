<script lang="ts">
	import type { Snippet } from "svelte";
	import { cn } from "$lib/utils";
	import { Label } from "$lib/components/ui/label";

	interface Props {
		/** id des Bedienelements; verknuepft Label und Control.
		 *  Entfaellt, wenn rechts kein einzelnes Feld steht (z.B. wechselnde Zustaende). */
		id?: string;
		title: string;
		/** erklaerende Zeile darunter – hier gehoeren Hinweise wie "0 = aus" hin */
		description?: string;
		/** das Bedienelement rechts */
		control: Snippet;
		/** Zusatzklassen fuer die Zeile */
		class?: string;
	}
	let { id, title, description, control, class: className }: Props = $props();
</script>

<!--
	Umbrechende Zeile statt fester Aufteilung: schmale Bedienelemente (Schalter,
	Zahlenfeld) bleiben neben ihrer Beschriftung stehen, breite (Auswahllisten)
	rutschen von selbst darunter, sobald beides nicht mehr nebeneinander passt.
	basis-32 ist die Schwelle - so viel Platz braucht die Beschriftung mindestens,
	sonst steht dort eine Spalte von zwei Wörtern Breite.
-->
<div class={cn("flex flex-wrap items-center justify-between gap-x-6 gap-y-2", className)}>
	<Label for={id} class="min-w-0 grow basis-32 flex-col items-start gap-1">
		<span class="text-sm font-medium">{title}</span>
		{#if description}
			<span class="text-muted-foreground text-xs leading-relaxed font-normal text-pretty">
				{description}
			</span>
		{/if}
	</Label>
	<div class="shrink-0">
		{@render control()}
	</div>
</div>
