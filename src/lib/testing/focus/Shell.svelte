<script lang="ts">
	// Nachbau der App-Shell: kennt den Tab. `wiring` waehlt den alten Aufbau
	// (Effekt auf pendingDate) oder den neuen (Rueckruf).
	import { entriesFocus } from "../../entriesFocus.svelte";
	import Child from "./Child.svelte";

	let {
		wiring,
		state
	}: { wiring: "effect" | "callback"; state: { tab: string; seen: { date: string | null } } } =
		$props();

	// Beide Verdrahtungen in Effekten, damit `wiring` in einer Closure gelesen
	// wird. Die Anmeldung passiert im ersten Durchlauf, also lange vor dem Klick.
	$effect(() => {
		if (wiring === "callback") entriesFocus.onShow(() => (state.tab = "entries"));
	});

	$effect(() => {
		if (wiring === "effect" && entriesFocus.pendingDate) state.tab = "entries";
	});
</script>

<!-- Genau wie in der App: der Verbraucher ist ein KIND der Shell. -->
<Child seen={state.seen} />
