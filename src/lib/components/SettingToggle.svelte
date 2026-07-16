<script lang="ts">
	// Einstellungs-Zeile mit Schalter. Duenner Aufsatz auf SettingRow, damit die
	// Zeile selbst nur einmal existiert.
	import SettingRow from "$lib/components/SettingRow.svelte";
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

<SettingRow {id} {title} {description} class={className}>
	{#snippet control()}
		<Switch {id} bind:checked {onCheckedChange} />
	{/snippet}
</SettingRow>
