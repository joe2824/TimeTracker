<script lang="ts">
	// Ein Timer lief über Mitternacht, während das Gerät offline war, und wurde
	// dabei automatisch in Tagesstücke geteilt. Hat ein anderes Gerät denselben
	// Lauf inzwischen früher beendet, weiss der Abgleich nicht, ob danach echt
	// weitergearbeitet wurde oder nicht - das kann nur ein Mensch entscheiden.
	// Deshalb bleiben beide Einträge stehen, und hier zeigt der Hinweis beide
	// Endzeiten direkt zur Auswahl an, statt nur auf den Zeiten-Bereich zu verweisen.
	import * as Dialog from "$lib/components/ui/dialog";
	import { Button } from "$lib/components/ui/button";
	import { account } from "$lib/sync/account.svelte";
	import { app } from "$lib/app.svelte";
	import { fmtClock, fmtDateHuman } from "$lib/time/time";
	import type { StaleTimerSplitInfo } from "$lib/sync/engine";

	// Wie viele beim letzten "Später" schon da waren - kommt danach ein neuer
	// Fall dazu, soll der Hinweis trotzdem wieder erscheinen.
	let dismissedCount = $state(0);

	const splits = $derived(account.staleTimerSplits);
	const open = $derived(splits.length > dismissedCount);

	function dismiss() {
		dismissedCount = splits.length;
	}

	function continuationLabel(s: StaleTimerSplitInfo): string {
		return s.continuationEntry.endTs === null
			? "weiter, läuft noch"
			: `weiter bis ${fmtClock(s.continuationEntry.endTs)} Uhr (${fmtDateHuman(s.continuationEntry.startTs)})`;
	}

	async function resolve(s: StaleTimerSplitInfo, keep: "ended" | "continuation") {
		await app.resolveStaleTimerSplit(s, keep);
		account.staleTimerSplits = account.staleTimerSplits.filter((x) => x !== s);
	}
</script>

<Dialog.Root
	{open}
	onOpenChange={(o) => {
		if (!o) dismiss();
	}}
>
	<Dialog.Content
		class="grid max-h-[calc(100dvh-1.5rem)] grid-rows-[auto_minmax(0,1fr)_auto] sm:max-w-md"
	>
		<Dialog.Header>
			<Dialog.Title>Bitte einen Tag prüfen</Dialog.Title>
			<Dialog.Description>
				Ein Timer lief über Mitternacht, während dieses Gerät keine Verbindung zum Server hatte.
				Auf einem anderen Gerät wurde er in der Zwischenzeit schon früher beendet. Welche Zeit
				stimmt?
			</Dialog.Description>
		</Dialog.Header>

		<div class="min-h-0 space-y-3 overflow-y-auto pr-1">
			{#each splits as s (s.endedEntry.id + "/" + s.continuationEntry.id)}
				<div class="space-y-1.5 border-b pb-3 last:border-0">
					<div class="text-sm font-medium">{app.activityName(s.endedEntry.activityId)}</div>
					<div class="text-muted-foreground text-xs">{fmtDateHuman(s.endedEntry.startTs)}</div>
					<div class="flex flex-col gap-1.5 sm:flex-row">
						<Button
							variant="outline"
							class="h-auto flex-1 justify-start py-2 text-left whitespace-normal"
							onclick={() => resolve(s, "ended")}
						>
							{s.endedEntry.endTs === null ? "endet hier" : `bis ${fmtClock(s.endedEntry.endTs)} Uhr`}
						</Button>
						<Button
							variant="outline"
							class="h-auto flex-1 justify-start py-2 text-left whitespace-normal"
							onclick={() => resolve(s, "continuation")}
						>
							{continuationLabel(s)}
						</Button>
					</div>
				</div>
			{/each}
		</div>

		<Dialog.Footer>
			<Button variant="ghost" onclick={dismiss}>Später</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
