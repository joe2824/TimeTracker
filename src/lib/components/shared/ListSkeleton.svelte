<script lang="ts">
	// Platzhalter für eine Liste mit Symbol, zwei Textzeilen und einer Aktion
	// rechts, solange die Zeilen noch vom Server kommen.
	import { Skeleton } from "$lib/components/ui/skeleton";

	let {
		rows = 2,
		actionClass = "w-16",
		class: cls = ""
	}: { rows?: number; actionClass?: string; class?: string } = $props();
</script>

<div class="space-y-2 {cls}">
	<Skeleton class="h-3 w-36" />
	<div class="divide-y rounded-lg border bg-card">
		{#each Array(rows) as _}
			<div class="flex items-center justify-between p-3">
				<div class="flex items-center gap-3 min-w-0">
					<Skeleton class="size-8 rounded-md shrink-0" />
					<div class="space-y-1.5 min-w-0">
						<Skeleton class="h-4 w-32" />
						<Skeleton class="h-3 w-24" />
					</div>
				</div>
				<Skeleton class="h-8 {actionClass} rounded-md shrink-0" />
			</div>
		{/each}
	</div>
</div>
