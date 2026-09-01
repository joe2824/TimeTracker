<script lang="ts">
	import { Label } from "$lib/components/ui/label";
	import * as RadioGroup from "$lib/components/ui/radio-group";

	interface Props {
		/** true = Zeitausgleich statt Urlaub/Krank */
		value: boolean;
		id?: string;
		label?: string;
	}
	let { value = $bindable(false), id = "kind", label = "Art" }: Props = $props();

	// Gerechnet wird beides gleich - beide fuellen das Tagessoll. Der Unterschied
	// ist die Beschriftung, damit spaeter erkennbar bleibt, warum der Tag frei war.
	const options = [
		{ value: "absence", title: "Abwesenheit", hint: "Urlaub, krank, frei" },
		{ value: "timeoff", title: "Zeitausgleich", hint: "abgefeierte Überstunden" }
	];
</script>

<div class="space-y-1">
	<Label>{label}</Label>
	<RadioGroup.Root
		value={value ? "timeoff" : "absence"}
		onValueChange={(v) => (value = v === "timeoff")}
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
					<span class="text-muted-foreground block truncate text-xs">{option.hint}</span>
				</span>
			</Label>
		{/each}
	</RadioGroup.Root>
</div>
