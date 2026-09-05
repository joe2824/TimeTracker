<script lang="ts">
	import { app } from "$lib/app.svelte";
	import { listEntryMonths } from "$lib/store";
	import { monthLabel, shiftMonthKey } from "$lib/time/time";
	import { onIntent, prefetchMonth, prefetchRemoteMonths } from "$lib/ui/prefetch";
	import { account } from "$lib/sync/account.svelte";
	import { Button } from "$lib/components/ui/button";
	import * as ButtonGroup from "$lib/components/ui/button-group";
	import * as Select from "$lib/components/ui/select";
	import { Label } from "$lib/components/ui/label";
	import ChevronLeftIcon from "@lucide/svelte/icons/chevron-left";
	import ChevronRightIcon from "@lucide/svelte/icons/chevron-right";
	import LoaderCircleIcon from "@lucide/svelte/icons/loader-circle";

	interface Props {
		/** ausgewaehlter Monat "YYYY-MM" */
		month: string;
		/** id des Triggers, damit das Label korrekt verknuepft ist */
		id?: string;
	}
	let { month = $bindable(), id = "month" }: Props = $props();

	/** Monate mit Eintraegen (von der Platte). */
	let stored = $state<string[]>([]);

	// Neu lesen, sobald sich Eintraege irgendwo geaendert haben - sonst bliebe ein
	// geloeschtes Jahr bis zum Neuladen der Seite in der Auswahl.
	$effect(() => {
		app.entriesVersion;
		void listEntryMonths().then((m) => (stored = m));
	});

	/** Monate, die beim Server liegen und hier noch nicht. */
	let remote = $state<string[]>([]);

	// Nur solange die Historie noch laeuft. Danach steht alles auf der Platte -
	// dann waere die Anfrage bei jeder Ansicht mit Monatsauswahl fuer nichts.
	$effect(() => {
		if (!account.backfilling) return;
		void prefetchRemoteMonths().then((m) => (remote = m));
	});

	// Abgeleitet statt mutiert: dadurch kann sich kein leerer Monat dauerhaft in die
	// Liste schreiben – er verschwindet, sobald man ihn verlaesst. Aktueller und
	// ausgewaehlter Monat sind immer dabei, sonst hat der Trigger nichts anzuzeigen.
	const months = $derived(
		[...new Set([app.currentMonth, month, ...stored, ...remote])].sort().reverse()
	);
	const isCurrent = $derived(month === app.currentMonth);

	/**
	 * Wird dieser Monat gerade vom Server geholt?
	 *
	 * Ohne den Hinweis sieht ein Klick auf einen alten Monat bei schlechter
	 * Verbindung nach "nichts passiert" aus - dabei laeuft der Abruf gerade.
	 */
	function isFetching(m: string): boolean {
		return account.fetchingMonths.includes(m);
	}

	/** Einen Monat vor/zurück blättern – auch in (noch) leere Monate. */
	function shiftMonth(delta: number) {
		month = neighbour(delta);
	}

	function neighbour(delta: number): string {
		return shiftMonthKey(month, delta);
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
				{...onIntent(() => prefetchMonth(neighbour(-1)))}
			>
				<ChevronLeftIcon />
			</Button>
			<Select.Root type="single" bind:value={month}>
				<!-- Feste Breite: der laengste Monatsname ("September 2026") passt hinein,
				     dadurch springt der Pfeil rechts beim Blaettern nicht. -->
				<Select.Trigger {id} class="w-40">
					<span class="flex items-center gap-2">
						{monthLabel(month)}
						{#if isFetching(month)}
							<LoaderCircleIcon class="size-3.5 shrink-0 animate-spin" aria-hidden="true" />
						{/if}
					</span>
				</Select.Trigger>
				<Select.Content>
					{#each months as m (m)}
						<Select.Item value={m} label={monthLabel(m)} {...onIntent(() => prefetchMonth(m))}>
							<span class="flex items-center gap-2">
								{monthLabel(m)}
								{#if isFetching(m)}
									<LoaderCircleIcon class="size-3.5 shrink-0 animate-spin" aria-hidden="true" />
								{/if}
							</span>
						</Select.Item>
					{/each}
				</Select.Content>
			</Select.Root>
			<Button
				variant="outline"
				size="icon"
				aria-label="Nächster Monat"
				title="Nächster Monat"
				onclick={() => shiftMonth(1)}
				{...onIntent(() => prefetchMonth(neighbour(1)))}
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
