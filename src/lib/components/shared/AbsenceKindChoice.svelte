<script lang="ts">
	import RadioCards from "./RadioCards.svelte";

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

<RadioCards
	{id}
	{label}
	{options}
	value={value ? "timeoff" : "absence"}
	onChange={(v) => (value = v === "timeoff")}
/>
