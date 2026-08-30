<script lang="ts">
	import { account } from "$lib/sync/account.svelte";
	import { isTauri } from "$lib/platform/env";

	// Nur im Browser zeigen – in Tauri reicht der Toast.
	// Das Modal erscheint, sobald ein Massen-Pull lauft (>= 20 Eintraege).
	const showModal = $derived(
		!isTauri() &&
			account.syncProgress !== null &&
			account.syncProgress.phase === "pulling" &&
			account.syncProgress.pulled >= 20
	);

	const pulled = $derived(account.syncProgress?.pulled ?? 0);
</script>

{#if showModal}
	<!--
		Kein Dialog.Root, weil dieses Modal nicht schliessbar ist – der Nutzer
		soll nicht dazwischenfunken, waehrend die Daten ankommen. Ein einfaches
		Overlay reicht.
	-->
	<div
		class="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm"
		aria-modal="true"
		role="dialog"
		aria-labelledby="sync-modal-title"
	>
		<div
			class="bg-card text-card-foreground flex w-full max-w-sm flex-col items-center gap-5 rounded-xl border p-8 shadow-xl"
		>
			<!-- Spinner -->
			<div class="relative h-12 w-12">
				<svg
					class="h-12 w-12 animate-spin"
					viewBox="0 0 48 48"
					fill="none"
					xmlns="http://www.w3.org/2000/svg"
					aria-hidden="true"
				>
					<circle
						class="opacity-20"
						cx="24"
						cy="24"
						r="20"
						stroke="currentColor"
						stroke-width="4"
					/>
					<path
						class="opacity-80"
						d="M44 24c0-11.046-8.954-20-20-20"
						stroke="currentColor"
						stroke-width="4"
						stroke-linecap="round"
					/>
				</svg>
			</div>

			<div class="space-y-1 text-center">
				<p id="sync-modal-title" class="text-base font-semibold">Daten werden synchronisiert</p>
				<p class="text-muted-foreground text-sm">
					{pulled}
					{pulled === 1 ? "Eintrag" : "Einträge"} geladen …
				</p>
			</div>
		</div>
	</div>
{/if}
