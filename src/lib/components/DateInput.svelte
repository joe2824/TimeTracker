<script lang="ts">
	// Datums-Eingabefeld mit natürlichem ↑/↓-Stepping: verschiebt das GANZE Datum
	// um ±1 Tag (mit Monats-/Jahresübergang), statt nur das Tages-Segment umzubrechen.
	// Ein vom Aufrufer übergebenes onkeydown wird zuerst ausgeführt und respektiert.
	import { Input } from "$lib/components/ui/input";
	import { stepDate } from "$lib/time";
	import type { HTMLInputAttributes } from "svelte/elements";

	type KeydownHandler = NonNullable<HTMLInputAttributes["onkeydown"]>;

	let {
		value = $bindable(""),
		onkeydown,
		...rest
	}: { value?: string; onkeydown?: KeydownHandler } & Omit<
		HTMLInputAttributes,
		"value" | "type" | "files" | "onkeydown"
	> = $props();

	const handleKeydown: KeydownHandler = (e) => {
		onkeydown?.(e); // zuerst den Aufrufer …
		if (e.defaultPrevented) return; // … und dessen preventDefault respektieren
		if ((e.key === "ArrowUp" || e.key === "ArrowDown") && value) {
			e.preventDefault();
			value = stepDate(value, e.key === "ArrowUp" ? 1 : -1);
		}
	};
</script>

<Input {...rest} type="date" bind:value onkeydown={handleKeydown} />
