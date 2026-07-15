<script lang="ts">
	// Datums-Eingabefeld mit natürlichem ↑/↓-Stepping: verschiebt das GANZE Datum
	// um ±1 Tag (mit Monats-/Jahresübergang), statt nur das Tages-Segment umzubrechen.
	import { Input } from "$lib/components/ui/input";
	import { stepDate } from "$lib/time";
	import type { HTMLInputAttributes } from "svelte/elements";

	let {
		value = $bindable(""),
		...rest
	}: { value?: string } & Omit<HTMLInputAttributes, "value" | "type" | "files"> = $props();

	function handleKeydown(e: KeyboardEvent) {
		if ((e.key === "ArrowUp" || e.key === "ArrowDown") && value) {
			e.preventDefault();
			value = stepDate(value, e.key === "ArrowUp" ? 1 : -1);
		}
	}
</script>

<Input {...rest} type="date" bind:value onkeydown={handleKeydown} />
