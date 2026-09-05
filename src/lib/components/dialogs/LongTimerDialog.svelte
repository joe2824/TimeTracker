<script lang="ts">
	import * as Dialog from "$lib/components/ui/dialog";
	import { Button } from "$lib/components/ui/button";
	import { Input } from "$lib/components/ui/input";
	import { Label } from "$lib/components/ui/label";
	import { app } from "$lib/app.svelte";
	import { fmtClock, fmtDate, fmtDateHuman, fmtHMS, monthKey } from "$lib/time/time";
	import { checkEnd, suggestLongTimerEnd } from "$lib/time/longTimer";
	import { watchers, resolveLongTimer } from "$lib/ui/watchers.svelte";

	const p = $derived(watchers.longTimerPrompt);
	const open = $derived(!!p);

	// Über mehrere Tage sagt die Uhrzeit allein nichts – dann gehört der Tag dazu.
	const overnight = $derived(!!p && fmtDate(p.startTs) !== fmtDate(app.now));
	const startLabel = $derived(
		!p ? "" : overnight ? `${fmtDateHuman(p.startTs)} ${fmtClock(p.startTs)}` : fmtClock(p.startTs)
	);

	/** datetime-local-Wert "YYYY-MM-DDTHH:MM" der eingegebenen Endzeit. */
	let endValue = $state("");

	function toLocal(ts: number): string {
		return `${fmtDate(ts)}T${fmtClock(ts)}`;
	}

	/** Frühester Projekt-Eintrag des Starttags – Grundlage der Schätzung. */
	function dayStartTs(startTs: number): number | null {
		const key = fmtDate(startTs);
		let first: number | null = null;
		for (const e of app.monthEntries(monthKey(startTs))) {
			if (app.isAbsenceId(e.activityId) || fmtDate(e.startTs) !== key) continue;
			if (first === null || e.startTs < first) first = e.startTs;
		}
		return first;
	}

	// Beim Öffnen vorbelegen. NICHT mit "jetzt": lief der Timer über Nacht, ist
	// "jetzt" der Morgen danach, und ein unbesehen bestätigter Dialog schreibt
	// die ganze Nacht auf das Projekt.
	$effect(() => {
		if (!p) return;
		const start = p.startTs;
		endValue = toLocal(
			suggestLongTimerEnd({
				runStartTs: start,
				now: Date.now(),
				dayStartTs: dayStartTs(start),
				hoursPerDay: app.settings.hoursPerDay,
				deductBreaks: app.settings.breakDeduction
			})
		);
	});

	const endTs = $derived(endValue ? new Date(endValue).getTime() : NaN);
	const error = $derived(p ? checkEnd(endTs, p.startTs, app.now) : null);
	const errorText = $derived(
		error === "future"
			? "Das liegt in der Zukunft – steht das Datum auf dem richtigen Tag?"
			: error === "before-start"
				? `Das liegt vor dem Start (${startLabel}).`
				: error === "invalid"
					? "Keine gültige Zeit."
					: ""
	);
	/** Was tatsächlich gebucht wird – vor dem Klick sichtbar. */
	const preview = $derived(
		!p || error
			? ""
			: `Gebucht wird ${fmtHMS((endTs - p.startTs) / 1000)} bis ${fmtDateHuman(endTs)} ${fmtClock(endTs)}.`
	);

	function stopAt() {
		if (!p || error) return;
		void resolveLongTimer("stop", endTs);
	}
</script>

<Dialog.Root
	{open}
	onOpenChange={(v) => {
		if (!v) void resolveLongTimer("keep");
	}}
>
	<Dialog.Content class="sm:max-w-md">
		<Dialog.Header>
			<Dialog.Title>Timer läuft noch</Dialog.Title>
			<Dialog.Description>
				{#if p}
					„{app.activityName(p.activityId)}" läuft seit
					<strong>{fmtHMS(p.elapsedSec)}</strong> (Start {startLabel}). Wann hast du aufgehört?
				{/if}
			</Dialog.Description>
		</Dialog.Header>
		<div class="space-y-1">
			<Label for="long-end">Ende</Label>
			<Input
				id="long-end"
				type="datetime-local"
				bind:value={endValue}
				aria-invalid={!!error}
				min={p ? toLocal(p.startTs) : undefined}
				max={toLocal(app.now)}
			/>
			{#if overnight}
				<p class="text-muted-foreground text-xs">
					Der Timer lief über Nacht – gemeint ist vermutlich noch der {fmtDateHuman(p!.startTs)}.
					Vorbelegt ist der geschätzte Feierabend; Datum mit prüfen.
				</p>
			{/if}
			{#if error}
				<p class="text-destructive text-xs">{errorText}</p>
			{:else}
				<p class="text-muted-foreground text-xs">{preview}</p>
			{/if}
		</div>
		<Dialog.Footer>
			<Button variant="outline" onclick={() => resolveLongTimer("keep")}>Weiterlaufen lassen</Button>
			<Button onclick={stopAt} disabled={!!error}>Beenden</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
