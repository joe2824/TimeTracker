<script lang="ts">
	// Nach dem Beitritt heissen eigene Aktivitäten oft genauso wie die des Teams.
	// Die Frage stellt sich von selbst, sobald beide Zeilen da sind - auch auf
	// einem zweiten Gerät oder wenn das Team später eine Aktivität dazubekommt.
	import * as Dialog from "$lib/components/ui/dialog";
	import { Button } from "$lib/components/ui/button";
	import { Checkbox } from "$lib/components/ui/checkbox";
	import { Label } from "$lib/components/ui/label";
	import { app } from "$lib/app.svelte";
	import { account } from "$lib/sync/account.svelte";
	import { findMergeCandidates, resolveMergeOffer } from "$lib/team/mergeOffer";
	import { errorText } from "$lib/log";
	import { toast } from "svelte-sonner";

	// Mit Konto erst, wenn alles da ist: welche Paare schon abgelehnt wurden,
	// steht in den Einstellungen des Kontos, und Zeiten in Monaten, die noch
	// nicht geladen sind, blieben sonst an der eigenen Aktivität hängen.
	const ready = $derived(!account.linked || (account.firstSyncDone && !account.historyIncomplete));
	const candidates = $derived(
		ready ? findMergeCandidates(app.activities, app.settings.teamMergeDeclined) : []
	);

	/** „Später“: in diesem Lauf nicht mehr fragen. */
	let snoozed = $state(false);
	/** Abgewählte eigene Aktivitäten - alles Übrige gilt als gewählt. */
	let unchecked = $state<ReadonlySet<string>>(new Set());
	let busy = $state(false);

	const open = $derived(candidates.length > 0 && !snoozed);
	const selected = $derived(
		new Set(candidates.filter((c) => !unchecked.has(c.own.id)).map((c) => c.own.id))
	);

	function toggle(id: string, checked: boolean) {
		const next = new Set(unchecked);
		if (checked) next.delete(id);
		else next.add(id);
		unchecked = next;
	}

	async function resolve(ownIds: ReadonlySet<string>) {
		if (busy) return;
		busy = true;
		try {
			const merged = await resolveMergeOffer(candidates, ownIds);
			if (merged > 0) {
				toast.success(merged === 1 ? "Eine Aktivität zusammengeführt." : `${merged} Aktivitäten zusammengeführt.`);
			}
		} catch (e) {
			toast.error(`Zusammenführen fehlgeschlagen: ${errorText(e)}`);
			snoozed = true;
		} finally {
			busy = false;
		}
	}
</script>

<Dialog.Root
	{open}
	onOpenChange={(o) => {
		if (!o && !busy) snoozed = true;
	}}
>
	<Dialog.Content
		class="grid max-h-[calc(100dvh-1.5rem)] grid-rows-[auto_minmax(0,1fr)_auto] sm:max-w-md"
		interactOutsideBehavior={busy ? "ignore" : "close"}
		escapeKeydownBehavior={busy ? "ignore" : "close"}
		showCloseButton={!busy}
	>
		<Dialog.Header>
			<Dialog.Title>Gleiche Aktivitäten zusammenführen?</Dialog.Title>
			<Dialog.Description>
				Diese eigenen Aktivitäten heißen genauso wie Aktivitäten deines Teams. Zusammengeführt wandern
				alle ihre Zeiten zur Team-Aktivität, und die eigene Aktivität verschwindet. Wähle aus, welche
				zusammengeführt werden sollen.
			</Dialog.Description>
		</Dialog.Header>

		<div class="min-h-0 space-y-2 overflow-y-auto pr-1">
			{#each candidates as c (c.own.id)}
				<div class="flex items-center gap-3 rounded-md border px-3 py-2">
					<Checkbox
						id={`merge-${c.own.id}`}
						checked={selected.has(c.own.id)}
						disabled={busy}
						onCheckedChange={(v) => toggle(c.own.id, v === true)}
					/>
					<Label for={`merge-${c.own.id}`} class="min-w-0 flex-1 cursor-pointer font-normal">
						<span class="block truncate font-medium">{c.own.name}</span>
						{#if c.team.teamName}
							<span class="text-muted-foreground block truncate text-xs">Team „{c.team.teamName}“</span>
						{/if}
					</Label>
				</div>
			{/each}
		</div>

		<Dialog.Footer>
			<Button variant="ghost" disabled={busy} onclick={() => (snoozed = true)}>Später</Button>
			<Button variant="outline" disabled={busy} onclick={() => resolve(new Set())}>Getrennt lassen</Button>
			<Button disabled={busy || selected.size === 0} onclick={() => resolve(selected)}>
				{busy ? "Wird zusammengeführt…" : "Zusammenführen"}
			</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
