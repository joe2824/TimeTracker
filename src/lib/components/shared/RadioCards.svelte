<script lang="ts">
	// Zwei bis drei Wahlmoeglichkeiten als Karten nebeneinander, jede mit einer
	// Zeile darunter, die sagt, was sie bedeutet. Genau ein Feld, keine Logik -
	// wofuer die Wahl steht, weiss der Aufrufer.
	import { Label } from "$lib/components/ui/label";
	import * as RadioGroup from "$lib/components/ui/radio-group";

	interface RadioCard {
		value: string;
		title: string;
		/** Die zweite Zeile - kurz halten, sie wird abgeschnitten. */
		hint: string;
	}

	interface Props {
		value: string;
		/** Zwei Spalten breit; ab drei Karten bricht die dritte in die naechste Reihe. */
		options: RadioCard[];
		onChange: (value: string) => void;
		/** Praefix der Feld-ids, damit die Beschriftungen richtig verknuepft sind. */
		id: string;
		/** Feldbeschriftung darueber. */
		label: string;
	}
	let { value, options, onChange, id, label }: Props = $props();
</script>

<div class="space-y-1">
	<Label>{label}</Label>
	<RadioGroup.Root {value} onValueChange={onChange} class="grid grid-cols-2 gap-2">
		{#each options as option (option.value)}
			<Label
				for={`${id}-${option.value}`}
				class="hover:bg-accent/50 has-data-checked:border-primary has-data-checked:bg-primary/5 flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2 font-normal"
			>
				<RadioGroup.Item id={`${id}-${option.value}`} value={option.value} />
				<span class="min-w-0">
					<span class="block truncate text-sm">{option.title}</span>
					<span class="text-muted-foreground block truncate text-xs">{option.hint}</span>
				</span>
			</Label>
		{/each}
	</RadioGroup.Root>
</div>
