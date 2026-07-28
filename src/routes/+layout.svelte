<script lang="ts">
	import "../app.css";
	import { onMount } from "svelte";
	import { ModeWatcher } from "mode-watcher";
	import { Toaster } from "$lib/components/ui/sonner";
	import { flushLog, installErrorLogging } from "$lib/log";

	let { children } = $props();

	// Im Layout, damit BEIDE Fenster (Hauptfenster und Tray-Flyout) erfasst sind:
	// ein Fehler, den niemand faengt, ist sonst nur daran zu merken, dass etwas
	// nicht passiert.
	onMount(() => {
		const off = installErrorLogging();
		return () => {
			off();
			void flushLog();
		};
	});
</script>

<ModeWatcher />
<Toaster richColors closeButton />
{@render children()}
