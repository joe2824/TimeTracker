<script lang="ts">
	// Gehört ins Hauptfenster, nicht in die Einstellungs-Seite: der Hinweis auf ein
	// Update kommt beim Start, lange bevor jemand die Einstellungen öffnet.
	import * as Dialog from "$lib/components/ui/dialog";
	import { Button } from "$lib/components/ui/button";
	import { installUpdate, updater } from "$lib/release/updater.svelte";
	import { breakingNotes } from "$lib/release/releaseNotes";

	const u = $derived(updater.pending);
	// Nur Breaking Changes. Was sonst neu ist, erzaehlt der „Was ist neu"-Dialog
	// beim Start eines Haupt-Releases - hier stand sonst der ganze Release-Text
	// als Rohtext, samt Markdown-Zeichen und Zeilen, die nur auf GitHub passen.
	const warnings = $derived(breakingNotes(u?.body));
</script>

<Dialog.Root
	open={updater.open && !!u}
	onOpenChange={(v) => {
		if (!v && !updater.installing) updater.open = false;
	}}
>
	<Dialog.Content class="sm:max-w-md">
		<Dialog.Header>
			<Dialog.Title>Update verfügbar</Dialog.Title>
			<Dialog.Description>
				Version {u?.version}
				{#if u?.date}· {u.date.split(" ")[0]}{/if}
			</Dialog.Description>
		</Dialog.Header>

		{#if warnings.length > 0}
			<div
				class="border-amber-500/55 bg-amber-500/7 max-h-40 overflow-y-auto overscroll-contain rounded-lg border p-3 text-sm leading-relaxed text-amber-700 dark:text-amber-400"
			>
				<p class="mb-1 font-medium">Wichtig vor dem Update</p>
				<ul class="list-disc space-y-1 ps-4">
					{#each warnings as warning (warning)}
						<li>{warning}</li>
					{/each}
				</ul>
			</div>
		{/if}

		{#if updater.installing}
			<div class="space-y-1">
				<div class="bg-muted h-2 w-full overflow-hidden rounded-full">
					<div
						class="bg-primary h-full rounded-full transition-all"
						style={`width:${updater.progress < 0 ? 100 : updater.progress}%`}
						class:animate-pulse={updater.progress < 0}
					></div>
				</div>
				<p class="text-muted-foreground text-xs">
					{#if updater.progress < 0}
						Lädt…
					{:else}
						{updater.progress}%{#if updater.totalBytes}
							· {(updater.downloaded / 1e6).toFixed(1)} / {(updater.totalBytes / 1e6).toFixed(1)} MB{/if}
					{/if}
				</p>
			</div>
		{/if}

		<Dialog.Footer>
			<Button
				variant="outline"
				disabled={updater.installing}
				onclick={() => (updater.open = false)}
			>
				Später
			</Button>
			<Button disabled={updater.installing} onclick={installUpdate}>
				{updater.installing ? "Installiere…" : "Jetzt installieren"}
			</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
