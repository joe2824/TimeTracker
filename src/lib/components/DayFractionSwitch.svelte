<script lang="ts">
	// Ganzer/halber Abwesenheitstag – EINE Stelle fuer alle Dialoge.
	// Vorher dreimal gebaut: zwei <select> (EntryEditor, BulkEntryDialog) und ein
	// Switch (VacationRange). Die beiden <select> hatten sich auseinandergelebt und
	// zeigten dieselbe Einstellung unterschiedlich an – "7:30 h" gegen "7,5 h".
	import { app } from "$lib/app.svelte";
	import { fmtHoursClock } from "$lib/time";
	import { Label } from "$lib/components/ui/label";
	import { Switch } from "$lib/components/ui/switch";

	interface Props {
		/** Tagesanteil: 1 = ganzer Tag, 0.5 = halber Tag */
		value: number;
		/** id des Schalters, damit das Label korrekt verknuepft ist */
		id?: string;
		/** Feldbeschriftung darueber */
		label?: string;
	}
	let { value = $bindable(1), id = "frac", label = "Umfang" }: Props = $props();

	const half = $derived(value === 0.5);
	const hours = $derived(app.settings.hoursPerDay * (half ? 0.5 : 1));
</script>

<div class="space-y-1">
	<Label for={id}>{label}</Label>
	<div class="flex h-9 items-center justify-between gap-3">
		<span class="text-sm">
			{half ? "Halber Tag" : "Ganzer Tag"}
			<span class="text-muted-foreground">· {fmtHoursClock(hours)} h</span>
		</span>
		<Switch {id} checked={half} onCheckedChange={(v) => (value = v ? 0.5 : 1)} />
	</div>
</div>
