<script lang="ts">
	// Einstellungs-Zeile mit Schalter. Dünner Aufsatz auf SettingRow, damit die
	// Zeile selbst nur einmal existiert.
	import SettingRow from "$lib/components/shared/SettingRow.svelte";
	import { Switch } from "$lib/components/ui/switch";

	interface Props {
		/** id des Schalters; verknüpft Label und Switch */
		id: string;
		title: string;
		/** erklärende Zeile darunter (optional) */
		description?: string;
		checked: boolean;
		/** zusätzlich zum Binding, wenn das Umlegen selbst etwas auslöst */
		onCheckedChange?: (v: boolean) => void;
		/** Zusatzklassen für die Zeile, z.B. eine Trennlinie darüber */
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
		<Switch
			{id}
			bind:checked
			onCheckedChange={(v) => {
				checked = v;
				onCheckedChange?.(v);
			}}
		/>
	{/snippet}
</SettingRow>
