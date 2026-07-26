<script lang="ts">
	// Rueckfrage, wenn ein Eintrag ueber Mitternacht in einen Tag mit
	// Ganztags-Abwesenheit reicht: #reportConflict prueft nur den ersten Tag,
	// der Folgetag wird hier separat abgefangen (siehe app.svelte.ts,
	// addEntry/updateEntry). Bestaetigen entfernt die Abwesenheit(en) fuer
	// genau diese Tage und legt den Eintrag danach normal an.
	import * as Dialog from "$lib/components/ui/dialog";
	import { Button } from "$lib/components/ui/button";
	import { app } from "$lib/app.svelte";
	import { fmtDateHuman } from "$lib/time";
	import PalmtreeIcon from "@lucide/svelte/icons/palmtree";

	const p = $derived(app.absenceOverridePrompt);
	const open = $derived(!!p);
</script>

<Dialog.Root {open} onOpenChange={(v) => !v && (app.absenceOverridePrompt = null)}>
	<Dialog.Content class="sm:max-w-md">
		<Dialog.Header>
			<Dialog.Title>Abwesenheit entfernen?</Dialog.Title>
			<Dialog.Description>
				Der Eintrag reicht in einen Tag mit Ganztags-Abwesenheit. Dort kann keine Projektzeit
				neben einer Ganztags-Abwesenheit stehen.
			</Dialog.Description>
		</Dialog.Header>

		<div class="space-y-2">
			{#each p?.days ?? [] as d (d.entry.id)}
				<div class="flex items-center gap-2 text-sm">
					<PalmtreeIcon class="text-amber-600 dark:text-amber-400 size-4 shrink-0" />
					<span>
						<strong>{fmtDateHuman(d.entry.startTs)}</strong> · {d.activityName}
					</span>
				</div>
			{/each}
		</div>

		<Dialog.Footer>
			<Button variant="outline" onclick={() => (app.absenceOverridePrompt = null)}>Abbrechen</Button>
			<Button onclick={() => app.confirmAbsenceOverride()}>Abwesenheit entfernen und eintragen</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
