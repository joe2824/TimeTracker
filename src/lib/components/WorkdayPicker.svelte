<script lang="ts">
	// Auswahl der regulären Arbeitstage. `value` sind Wochentagsnummern (0=So..6=Sa).
	import { Button } from "$lib/components/ui/button";

	interface Props {
		value?: number[];
		/** feuert nach jedem Umschalten – fuers automatische Speichern */
		onchange?: () => void;
	}
	let { value = $bindable([] as number[]), onchange }: Props = $props();

	// Anzeige Mo–So (deutscher Wochenstart); n = getDay()-Wert.
	const DAYS = [
		{ n: 1, label: "Mo" },
		{ n: 2, label: "Di" },
		{ n: 3, label: "Mi" },
		{ n: 4, label: "Do" },
		{ n: 5, label: "Fr" },
		{ n: 6, label: "Sa" },
		{ n: 0, label: "So" }
	];

	function toggle(n: number) {
		value = value.includes(n) ? value.filter((d) => d !== n) : [...value, n].sort((a, b) => a - b);
		onchange?.();
	}
</script>

<div class="flex flex-wrap gap-1">
	{#each DAYS as d (d.n)}
		{@const on = value.includes(d.n)}
		<!-- Gewaehlt/ungewaehlt ueber die Button-Varianten statt eigener Klassen. -->
		<Button
			variant={on ? "default" : "outline"}
			size="sm"
			class="w-10"
			aria-pressed={on}
			onclick={() => toggle(d.n)}
		>
			{d.label}
		</Button>
	{/each}
</div>
