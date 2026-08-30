<script lang="ts">
	import { account } from "$lib/sync/account.svelte";
	import { isTauri } from "$lib/platform/env";
	import CheckIcon from "@lucide/svelte/icons/check";
	import RefreshCwIcon from "@lucide/svelte/icons/refresh-cw";

	// Nur im Browser anzeigen – in Tauri reicht der Desktop-Toast.
	// Das Modal erscheint, sobald ein Massen-Pull läuft (>= 20 Einträge).
	const showModal = $derived(!isTauri() && account.bulkSync !== null);
	const phase = $derived(account.bulkSync?.phase ?? "pulling");
	const pulled = $derived(account.bulkSync?.pulled ?? 0);
</script>

{#if showModal}
	<div
		class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm transition-opacity duration-200"
		aria-modal="true"
		role="dialog"
		aria-labelledby="sync-modal-title"
	>
		<div
			class="bg-card text-card-foreground flex w-full max-w-sm flex-col items-center gap-5 rounded-2xl border p-8 shadow-2xl"
		>
			{#if phase === "pulling"}
				<div
					class="relative flex h-14 w-14 items-center justify-center rounded-full bg-primary/10 text-primary"
				>
					<RefreshCwIcon class="h-7 w-7 animate-spin" />
				</div>

				<div class="space-y-1.5 text-center">
					<p id="sync-modal-title" class="text-base font-semibold">Daten werden synchronisiert</p>
					<p class="text-muted-foreground text-sm">
						{pulled}
						{pulled === 1 ? "Eintrag" : "Einträge"} geladen …
					</p>
				</div>
			{:else}
				<div
					class="relative flex h-14 w-14 items-center justify-center rounded-full bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
				>
					<CheckIcon class="h-7 w-7" />
				</div>

				<div class="space-y-1.5 text-center">
					<p
						id="sync-modal-title"
						class="text-base font-semibold text-emerald-600 dark:text-emerald-400"
					>
						Synchronisiert
					</p>
					<p class="text-muted-foreground text-sm">
						{pulled}
						{pulled === 1 ? "Eintrag" : "Einträge"} erfolgreich geladen.
					</p>
				</div>
			{/if}
		</div>
	</div>
{/if}
