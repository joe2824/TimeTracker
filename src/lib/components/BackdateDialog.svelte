<script lang="ts">
	// Rueckfrage vor einem rueckdatierten Timer-Start, der bereits erfasste Zeiten
	// anfasst.
	//
	// Muss auch im Tray-Flyout (300x420) funktionieren: dialog-content bringt weder
	// max-height noch overflow mit, und nebeneinander gestellt bleibt vom Namen bei
	// der Breite nichts uebrig. Deshalb: feste Hoehengrenze mit scrollender Liste
	// und je Zeile Name OBEN, Details darunter – das traegt jede Fensterbreite.
	import * as Dialog from "$lib/components/ui/dialog";
	import { Button } from "$lib/components/ui/button";
	import { app } from "$lib/app.svelte";
	import { fmtClock, fmtDateHuman, fmtHoursClock } from "$lib/time";
	import ActivityDot from "$lib/components/ActivityDot.svelte";

	const p = $derived(app.backdatePrompt);
	const open = $derived(!!p);

	const hours = (ms: number) => fmtHoursClock(Math.max(0, ms) / 3600000);

	interface Row {
		id: string;
		activityId: string;
		detail: string;
		drop: boolean;
	}

	/** Nur abgeschlossene Zeiten sind der Grund fuer die Rueckfrage. */
	const rows = $derived<Row[]>([
		...(p?.plan.truncate ?? [])
			.filter((t) => t.entry.endTs !== null)
			.map((t) => ({
				id: t.entry.id,
				activityId: t.entry.activityId,
				detail: `${fmtClock(t.entry.startTs)}–${fmtClock(t.entry.endTs as number)} → ${fmtClock(t.endTs)} · −${hours((t.entry.endTs as number) - t.endTs)} h`,
				drop: false
			})),
		...(p?.plan.remove ?? [])
			.filter((e) => e.endTs !== null)
			.map((e) => ({
				id: e.id,
				activityId: e.activityId,
				detail: `${fmtClock(e.startTs)}–${fmtClock(e.endTs as number)} · ${hours((e.endTs as number) - e.startTs)} h`,
				drop: true
			}))
	]);

	const cutCount = $derived(rows.filter((r) => !r.drop).length);
	const dropCount = $derived(rows.filter((r) => r.drop).length);
	const summary = $derived(
		[
			cutCount > 0 ? `${cutCount} gekürzt` : null,
			dropCount > 0 ? `${dropCount} gelöscht` : null
		]
			.filter(Boolean)
			.join(", ")
	);
</script>

<Dialog.Root {open} onOpenChange={(v) => !v && (app.backdatePrompt = null)}>
	<Dialog.Content
		class="grid max-h-[calc(100dvh-1.5rem)] grid-rows-[auto_minmax(0,1fr)_auto] sm:max-w-lg"
	>
		<Dialog.Header>
			<Dialog.Title>Erfasste Zeit anpassen?</Dialog.Title>
			<Dialog.Description>
				{#if p}
					„{app.activityName(p.activityId)}" ab {fmtClock(p.start)} ({fmtDateHuman(p.start)}) –
					{summary}.
				{/if}
			</Dialog.Description>
		</Dialog.Header>

		<div class="min-h-0 space-y-2 overflow-y-auto pr-1">
			{#each rows as r (r.id)}
				<div class="border-b pb-1.5 last:border-0">
					<div class="flex items-center gap-2">
						<ActivityDot color={app.activityColor(r.activityId)} />
						<span class="min-w-0 flex-1 truncate text-sm">{app.activityName(r.activityId)}</span>
					</div>
					<div class="ml-4 text-xs tabular-nums {r.drop ? 'text-destructive' : 'text-muted-foreground'}">
						{r.detail}{r.drop ? " · wird gelöscht" : ""}
					</div>
				</div>
			{/each}
		</div>

		<Dialog.Footer>
			<Button variant="outline" onclick={() => (app.backdatePrompt = null)}>Abbrechen</Button>
			<Button onclick={() => app.confirmBackdate()}>Anpassen und starten</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
