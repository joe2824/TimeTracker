<script lang="ts">
	// Gehört ins Hauptfenster, nicht in die Einstellungs-Seite: der Hinweis auf ein
	// Update kommt beim Start, lange bevor jemand die Einstellungen öffnet.
	import * as Dialog from "$lib/components/ui/dialog";
	import { Button } from "$lib/components/ui/button";
	import { installUpdate, updater } from "$lib/updater.svelte";

	const u = $derived(updater.pending);
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

		{#if u?.body}
			<div
				class="bg-muted/40 text-muted-foreground max-h-40 overflow-y-auto overscroll-contain rounded-lg p-3 text-sm leading-relaxed whitespace-pre-wrap"
			>
				{u.body}
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
