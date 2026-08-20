<script lang="ts">
	// Nachbau des Verbrauchers in EntryEditor: liest den Wunsch und raeumt ihn ab.
	import { entriesFocus } from "../../entriesFocus.svelte";
	let { seen }: { seen: { date: string | null } } = $props();

	$effect(() => {
		const date = entriesFocus.pendingDate;
		if (date) {
			entriesFocus.pendingDate = null;
			seen.date = date;
		}
	});
</script>
