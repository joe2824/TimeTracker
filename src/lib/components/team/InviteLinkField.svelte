<script lang="ts">
	// Ein Einladungs-Link mit Kopieren und Neu-Erzeugen - für Beitritts- und
	// Verwalter-Link in den Team-Einstellungen.
	import { Button } from "$lib/components/ui/button";
	import RefreshCwIcon from "@lucide/svelte/icons/refresh-cw";
	import CopyIcon from "@lucide/svelte/icons/copy";
	import Link2Icon from "@lucide/svelte/icons/link-2";

	interface Props {
		url: string | null;
		loading: boolean;
		rotating: boolean;
		/** Steht da, solange es keinen Link gibt. */
		emptyText: string;
		oncopy: () => void;
		onrotate: () => void;
	}
	let { url, loading, rotating, emptyText, oncopy, onrotate }: Props = $props();
</script>

{#if loading}
	<p class="text-muted-foreground text-sm">Wird geladen…</p>
{:else if url}
	<div class="flex flex-wrap items-center gap-2 rounded-lg border bg-muted/20 p-2.5">
		<div class="bg-primary/10 text-primary flex size-7 shrink-0 items-center justify-center rounded-md">
			<Link2Icon class="size-3.5" />
		</div>
		<code class="min-w-0 flex-1 truncate text-xs">{url}</code>
		<Button variant="ghost" size="icon-sm" title="Link kopieren" onclick={oncopy}>
			<CopyIcon class="size-4" />
		</Button>
		<Button variant="outline" size="sm" disabled={rotating} onclick={onrotate}>
			<RefreshCwIcon class="size-4" /> Neuen Link erzeugen
		</Button>
	</div>
{:else}
	<div class="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-dashed p-3.5">
		<div class="flex items-center gap-2.5">
			<div class="bg-muted flex size-7 shrink-0 items-center justify-center rounded-md">
				<Link2Icon class="text-muted-foreground size-3.5" />
			</div>
			<p class="text-muted-foreground text-xs">{emptyText}</p>
		</div>
		<Button variant="outline" size="sm" disabled={rotating} onclick={onrotate}>
			<RefreshCwIcon class="size-4" /> Link erzeugen
		</Button>
	</div>
{/if}
