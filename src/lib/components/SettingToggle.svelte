<script lang="ts">
	// Schalter-Zeile mit Titel und Erklaerung – das Standardmuster der Einstellungen.
	// Vorher fuenfmal identisch im SettingsPanel abgetippt.
	import { cn } from "$lib/utils";
	import { Label } from "$lib/components/ui/label";
	import { Switch } from "$lib/components/ui/switch";

	interface Props {
		/** id des Schalters; verknuepft Label und Switch */
		id: string;
		title: string;
		/** erklaerende Zeile darunter (optional) */
		description?: string;
		checked: boolean;
		/** zusaetzlich zum Binding, wenn das Umlegen selbst etwas ausloest */
		onCheckedChange?: (v: boolean) => void;
		/** Zusatzklassen fuer die Zeile, z.B. eine Trennlinie darueber */
		class?: string;
	}
	let {
		id,
		title,
		description,
		checked = $bindable(false),
		onCheckedChange,
		class: className
	}: Props = $props();
</script>

<div class={cn("flex items-center justify-between space-x-2", className)}>
	<Label for={id} class="flex flex-col items-start gap-1">
		<span class="text-sm font-medium">{title}</span>
		{#if description}
			<span class="text-muted-foreground text-xs font-normal">{description}</span>
		{/if}
	</Label>
	<Switch {id} bind:checked {onCheckedChange} />
</div>
