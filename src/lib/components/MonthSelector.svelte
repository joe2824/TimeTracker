<script lang="ts">
	import { app } from "$lib/app.svelte";
	import { listEntryMonths } from "$lib/store";
	import { monthLabel } from "$lib/time";
	import { Button } from "$lib/components/ui/button";
	import * as ButtonGroup from "$lib/components/ui/button-group";
	import * as Select from "$lib/components/ui/select";
	import { Label } from "$lib/components/ui/label";
	import ChevronLeftIcon from "@lucide/svelte/icons/chevron-left";
	import ChevronRightIcon from "@lucide/svelte/icons/chevron-right";

	interface Props {
		/** ausgewaehlter Monat "YYYY-MM" */
		month: string;
		/** id des Triggers, damit das Label korrekt verknuepft ist */
		id?: string;
	}
	let { month = $bindable(), id = "month" }: Props = $props();

	/** Monate mit Eintraegen (von der Platte). */
	let stored = $state<string[]>([]);

	// Neu lesen, sobald sich Eintraege geaendert haben – egal wo. Vorher musste
	// jeder Schreiber hier von Hand Bescheid sagen: ein in den Einstellungen
	// geloeschtes Jahr blieb deshalb bis zum Neuladen der Seite in der Auswahl.
	$effect(() => {
		app.entriesVersion;
		void listEntryMonths().then((m) => (stored = m));
	});

	// Abgeleitet statt mutiert: dadurch kann sich kein leerer Monat dauerhaft in die
	// Liste schreiben – er verschwindet, sobald man ihn verlaesst. Aktueller und
	// ausgewaehlter Monat sind immer dabei, sonst hat der Trigger nichts anzuzeigen.
	const months = $derived([...new Set([app.currentMonth, month, ...stored])].sort().reverse());
	const isCurrent = $derived(month === app.currentMonth);

	/** Einen Monat vor/zurück blättern – auch in (noch) leere Monate. */
	function shiftMonth(delta: number) {
		const [y, m] = month.split("-").map(Number);
		const d = new Date(y, m - 1 + delta, 1);
		month = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
	}
</script>

<div class="space-y-1">
	<Label for={id}>Monat</Label>
	<div class="flex items-center gap-2">
		<ButtonGroup.Root>
			<Button
				variant="outline"
				size="icon"
				aria-label="Vorheriger Monat"
				title="Vorheriger Monat"
				onclick={() => shiftMonth(-1)}
			>
				<ChevronLeftIcon />
			</Button>
			<Select.Root type="single" bind:value={month}>
				<!-- Feste Breite: der laengste Monatsname ("September 2026") passt hinein,
				     dadurch springt der Pfeil rechts beim Blaettern nicht. -->
				<Select.Trigger {id} class="w-40">
					{monthLabel(month)}
				</Select.Trigger>
				<Select.Content>
					{#each months as m (m)}
						<Select.Item value={m} label={monthLabel(m)}>{monthLabel(m)}</Select.Item>
					{/each}
				</Select.Content>
			</Select.Root>
			<Button
				variant="outline"
				size="icon"
				aria-label="Nächster Monat"
				title="Nächster Monat"
				onclick={() => shiftMonth(1)}
			>
				<ChevronRightIcon />
			</Button>
		</ButtonGroup.Root>
		{#if !isCurrent}
			<Button variant="outline" title="Zum aktuellen Monat" onclick={() => (month = app.currentMonth)}>
				Heute
			</Button>
		{/if}
	</div>
</div>
