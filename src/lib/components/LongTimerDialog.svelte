<script lang="ts">
	import * as Dialog from "$lib/components/ui/dialog";
	import { Button } from "$lib/components/ui/button";
	import { Input } from "$lib/components/ui/input";
	import { Label } from "$lib/components/ui/label";
	import { app } from "$lib/app.svelte";
	import { fmtClock, fmtDate, fmtHMS } from "$lib/time";
	import { watchers, resolveLongTimer } from "$lib/watchers.svelte";

	const p = $derived(watchers.longTimerPrompt);
	const open = $derived(!!p);

	/** datetime-local-Wert "YYYY-MM-DDTHH:MM" der eingegebenen Endzeit. */
	let endValue = $state("");

	function toLocal(ts: number): string {
		return `${fmtDate(ts)}T${fmtClock(ts)}`;
	}

	// Beim Öffnen mit der aktuellen Zeit vorbelegen (der Nutzer kann zurückdatieren).
	$effect(() => {
		if (p) endValue = toLocal(Date.now());
	});

	function stopAt() {
		if (!p) return;
		const ts = new Date(endValue).getTime();
		void resolveLongTimer("stop", Number.isNaN(ts) ? Date.now() : ts);
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
					<strong>{fmtHMS(p.elapsedSec)}</strong> (Start {fmtClock(p.startTs)}). Wann hast du
					aufgehört?
				{/if}
			</Dialog.Description>
		</Dialog.Header>
		<div class="space-y-1">
			<Label for="long-end">Ende</Label>
			<Input
				id="long-end"
				type="datetime-local"
				bind:value={endValue}
				min={p ? toLocal(p.startTs) : undefined}
				max={toLocal(Date.now())}
			/>
		</div>
		<Dialog.Footer>
			<Button variant="outline" onclick={() => resolveLongTimer("keep")}>Weiterlaufen lassen</Button>
			<Button onclick={stopAt}>Beenden</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
