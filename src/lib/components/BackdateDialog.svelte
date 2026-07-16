<script lang="ts">
	// Rueckfrage vor einem rueckdatierten Timer-Start, der bereits erfasste Zeiten
	// anfasst. Zeigt jede betroffene Zeile einzeln – wer blind bestaetigen muss,
	// bestaetigt irgendwann das Falsche.
	import * as Dialog from "$lib/components/ui/dialog";
	import { Button } from "$lib/components/ui/button";
	import { app } from "$lib/app.svelte";
	import { fmtClock, fmtDateHuman, fmtHoursClock } from "$lib/time";
	import ActivityDot from "$lib/components/ActivityDot.svelte";

	const p = $derived(app.backdatePrompt);
	const open = $derived(!!p);

	const hours = (from: number, to: number) => fmtHoursClock(Math.max(0, to - from) / 3600000);

	/** Nur abgeschlossene Zeiten sind der Grund fuer die Rueckfrage. */
	const cuts = $derived(
		(p?.plan.truncate ?? [])
			.filter((t) => t.entry.endTs !== null)
			.map((t) => ({
				id: t.entry.id,
				activityId: t.entry.activityId,
				von: t.entry.startTs,
				alt: t.entry.endTs as number,
				neu: t.endTs
			}))
	);
	const drops = $derived((p?.plan.remove ?? []).filter((e) => e.endTs !== null));
</script>

<Dialog.Root {open} onOpenChange={(v) => !v && (app.backdatePrompt = null)}>
	<Dialog.Content class="sm:max-w-lg">
		<Dialog.Header>
			<Dialog.Title>Bereits erfasste Zeit anpassen?</Dialog.Title>
			<Dialog.Description>
				{#if p}
					„{app.activityName(p.activityId)}" soll um {fmtClock(p.start)} beginnen
					({fmtDateHuman(p.start)}). Dort liegt schon erfasste Zeit.
				{/if}
			</Dialog.Description>
		</Dialog.Header>

		<div class="space-y-3 text-sm">
			{#each cuts as c (c.id)}
				<div class="flex items-center justify-between gap-3 border-b pb-2 last:border-0">
					<span class="flex min-w-0 items-center gap-2">
						<ActivityDot color={app.activityColor(c.activityId)} />
						<span class="truncate">{app.activityName(c.activityId)}</span>
					</span>
					<span class="text-muted-foreground shrink-0 tabular-nums">
						{fmtClock(c.von)}–<s>{fmtClock(c.alt)}</s>
						<strong class="text-foreground">{fmtClock(c.neu)}</strong>
						· −{hours(c.neu, c.alt)} h
					</span>
				</div>
			{/each}

			{#each drops as d (d.id)}
				<div class="flex items-center justify-between gap-3 border-b pb-2 last:border-0">
					<span class="flex min-w-0 items-center gap-2">
						<ActivityDot color={app.activityColor(d.activityId)} />
						<span class="truncate">{app.activityName(d.activityId)}</span>
					</span>
					<span class="text-destructive shrink-0 tabular-nums">
						{fmtClock(d.startTs)}–{fmtClock(d.endTs as number)} · wird gelöscht
					</span>
				</div>
			{/each}
		</div>

		<Dialog.Footer>
			<Button variant="outline" onclick={() => (app.backdatePrompt = null)}>Abbrechen</Button>
			<Button onclick={() => app.confirmBackdate()}>Anpassen und starten</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
