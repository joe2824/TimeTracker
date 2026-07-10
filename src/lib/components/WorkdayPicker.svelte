<script lang="ts">
	// Auswahl der regulären Arbeitstage. `value` sind Wochentagsnummern (0=So..6=Sa).
	let { value = $bindable([] as number[]) }: { value?: number[] } = $props();

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
	}
</script>

<div class="flex flex-wrap gap-1">
	{#each DAYS as d (d.n)}
		<button
			type="button"
			aria-pressed={value.includes(d.n)}
			class="w-10 rounded-md border px-2 py-1 text-sm transition-colors {value.includes(d.n)
				? 'border-primary bg-primary text-primary-foreground'
				: 'text-muted-foreground hover:bg-accent'}"
			onclick={() => toggle(d.n)}
		>
			{d.label}
		</button>
	{/each}
</div>
