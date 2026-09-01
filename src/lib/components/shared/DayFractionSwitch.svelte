<script lang="ts">
	import { app } from "$lib/app.svelte";
	import { fmtHoursClock } from "$lib/time";
	import { Label } from "$lib/components/ui/label";
	import * as RadioGroup from "$lib/components/ui/radio-group";

	interface Props {
		/** Tagesanteil: 1 = ganzer Tag, 0.5 = halber Tag */
		value: number;
		/** id des Feldes, damit das Label korrekt verknuepft ist */
		id?: string;
		/** Feldbeschriftung darueber */
		label?: string;
	}
	let { value = $bindable(1), id = "frac", label = "Umfang" }: Props = $props();

	// Zwei Knoepfe statt eines Schalters: am Schalter ist nicht zu sehen, was die
	// andere Stellung waere - man muss ihn umlegen, um es herauszufinden.
	const options = $derived([
		{ value: "1", title: "Ganzer Tag", hours: app.settings.hoursPerDay },
		{ value: "0.5", title: "Halber Tag", hours: app.settings.hoursPerDay / 2 }
	]);
</script>

<div class="space-y-1">
	<Label>{label}</Label>
	<RadioGroup.Root
		value={String(value)}
		onValueChange={(v) => (value = Number(v))}
		class="grid grid-cols-2 gap-2"
	>
		{#each options as option (option.value)}
			<Label
				for={`${id}-${option.value}`}
				class="hover:bg-accent/50 has-data-checked:border-primary has-data-checked:bg-primary/5 flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2 font-normal"
			>
				<RadioGroup.Item id={`${id}-${option.value}`} value={option.value} />
				<span class="min-w-0">
					<span class="block truncate text-sm">{option.title}</span>
					<span class="text-muted-foreground block text-xs">
						{fmtHoursClock(option.hours)} h
					</span>
				</span>
			</Label>
		{/each}
	</RadioGroup.Root>
</div>
