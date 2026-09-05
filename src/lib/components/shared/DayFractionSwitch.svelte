<script lang="ts">
	import { app } from "$lib/app.svelte";
	import { fmtHoursClock } from "$lib/time/time";
	import RadioCards from "./RadioCards.svelte";

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
		{ value: "1", title: "Ganzer Tag", hint: `${fmtHoursClock(app.settings.hoursPerDay)} h` },
		{
			value: "0.5",
			title: "Halber Tag",
			hint: `${fmtHoursClock(app.settings.hoursPerDay / 2)} h`
		}
	]);
</script>

<RadioCards
	{id}
	{label}
	{options}
	value={String(value)}
	onChange={(v) => (value = Number(v))}
/>
