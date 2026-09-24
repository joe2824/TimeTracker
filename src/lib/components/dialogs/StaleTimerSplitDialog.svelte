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
	import { errorText } from "$lib/log";
	import { toast } from "svelte-sonner";

	const keyOf = (s: StaleTimerSplitInfo) => `${s.endedEntry.id}/${s.continuationEntry.id}`;

	// Die Fälle beim letzten "Später" - kommt danach ein neuer dazu, erscheint
	// der Hinweis wieder. Nach Fällen statt nach Anzahl: sonst schlösse das
	// Lösen eines Falls den Dialog, obwohl ein neuer noch offen ist.
	let dismissed = $state<ReadonlySet<string>>(new Set());
	let busyKey = $state<string | null>(null);

	const splits = $derived(account.staleTimerSplits);
	const open = $derived(splits.some((s) => !dismissed.has(keyOf(s))));

	function dismiss() {
		dismissed = new Set(splits.map(keyOf));
	}

	function continuationLabel(s: StaleTimerSplitInfo): string {
		return s.continuationEntry.endTs === null
			? "Lief weiter und läuft noch"
			: `Lief weiter bis ${fmtClock(s.continuationEntry.endTs)} Uhr (${fmtDateHuman(s.continuationEntry.startTs)})`;
	}

	async function resolve(s: StaleTimerSplitInfo, keep: "ended" | "continuation") {
		if (busyKey) return;
		busyKey = keyOf(s);
		try {
			await app.resolveStaleTimerSplit(s, keep);
			account.staleTimerSplits = account.staleTimerSplits.filter((x) => x !== s);
		} catch (e) {
			toast.error(`Speichern fehlgeschlagen: ${errorText(e)}`);
		} finally {
			busyKey = null;
		}
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
				Ein Timer lief über Mitternacht, während dieses Gerät offline war. Auf einem anderen Gerät
				wurde er in der Zwischenzeit schon früher beendet. Welche Zeit stimmt?
			</Dialog.Description>
		</Dialog.Header>

		<div class="min-h-0 space-y-3 overflow-y-auto pr-1">
			{#each splits as s (keyOf(s))}
				<div class="space-y-1.5 border-b pb-3 last:border-0">
					<div class="text-sm font-medium">{app.activityName(s.endedEntry.activityId)}</div>
					<div class="text-muted-foreground text-xs">{fmtDateHuman(s.endedEntry.startTs)}</div>
					<div class="flex flex-col gap-1.5 sm:flex-row">
						<Button
							variant="outline"
							class="h-auto flex-1 justify-start py-2 text-left whitespace-normal"
							disabled={busyKey !== null}
							onclick={() => resolve(s, "ended")}
						>
							{s.endedEntry.endTs === null ? "Endete hier" : `Endete um ${fmtClock(s.endedEntry.endTs)} Uhr`}
						</Button>
						<Button
							variant="outline"
							class="h-auto flex-1 justify-start py-2 text-left whitespace-normal"
							disabled={busyKey !== null}
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
