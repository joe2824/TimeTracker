<script lang="ts">
	import * as Dialog from "$lib/components/ui/dialog";
	import { app } from "$lib/app.svelte";
	import PlayIcon from "@lucide/svelte/icons/play";
	import SquareIcon from "@lucide/svelte/icons/square";

	let { open = $bindable(false), onNavigate }: { open?: boolean; onNavigate?: (tab: string) => void } =
		$props();

	let query = $state("");
	let active = $state(0);

	type Item = { id: string; label: string; hint?: string; run: () => void; color?: string };

	const nav: Item[] = [
		{ id: "nav:tracking", label: "Gehe zu: Tracking", run: () => onNavigate?.("tracking") },
		{ id: "nav:entries", label: "Gehe zu: Einträge", run: () => onNavigate?.("entries") },
		{ id: "nav:report", label: "Gehe zu: Bericht", run: () => onNavigate?.("report") },
		{ id: "nav:activities", label: "Gehe zu: Aktivitäten", run: () => onNavigate?.("activities") },
		{ id: "nav:settings", label: "Gehe zu: Einstellungen", run: () => onNavigate?.("settings") }
	];

	function fuzzy(text: string, q: string): boolean {
		text = text.toLowerCase();
		q = q.toLowerCase();
		let i = 0;
		for (const ch of text) if (ch === q[i]) i++;
		return i === q.length;
	}

	const items = $derived.by<Item[]>(() => {
		const q = query.trim();
		const acts: Item[] = app.trackableActivities.map((a) => ({
			id: a.id,
			label: a.name,
			color: a.color,
			hint: app.running?.activityId === a.id ? "läuft" : a.shortcut,
			run: () => (app.running?.activityId === a.id ? app.stop() : app.startActivity(a.id))
		}));
		const all = [...acts, ...nav];
		if (!q) return all;
		return all.filter((i) => fuzzy(i.label, q));
	});

	$effect(() => {
		// active im gültigen Bereich halten, wenn sich die Liste ändert.
		void items;
		if (active >= items.length) active = Math.max(0, items.length - 1);
	});

	$effect(() => {
		if (open) {
			query = "";
			active = 0;
		}
	});

	function choose(i: Item) {
		i.run();
		open = false;
	}

	function onKey(e: KeyboardEvent) {
		if (e.key === "ArrowDown") {
			e.preventDefault();
			active = Math.min(active + 1, items.length - 1);
		} else if (e.key === "ArrowUp") {
			e.preventDefault();
			active = Math.max(active - 1, 0);
		} else if (e.key === "Enter") {
			e.preventDefault();
			const it = items[active];
			if (it) choose(it);
		}
	}
</script>

<Dialog.Root bind:open>
	<Dialog.Content class="overflow-hidden p-0 sm:max-w-lg" showCloseButton={false}>
		<input
			bind:value={query}
			onkeydown={onKey}
			placeholder="Timer starten oder navigieren…"
			class="w-full border-b bg-transparent px-4 py-3 text-sm outline-none"
		/>
		<ul class="max-h-80 overflow-y-auto p-1">
			{#each items as it, i (it.id)}
				<li>
					<button
						type="button"
						class="flex w-full cursor-pointer items-center gap-2 rounded-md px-3 py-2 text-left text-sm {i ===
						active
							? 'bg-accent text-accent-foreground'
							: ''}"
						onmouseenter={() => (active = i)}
						onclick={() => choose(it)}
					>
						{#if it.id.startsWith("nav:")}
							<span class="text-muted-foreground size-4 shrink-0"></span>
						{:else if app.running?.activityId === it.id}
							<SquareIcon class="size-4 shrink-0" />
						{:else}
							<PlayIcon class="size-4 shrink-0" />
						{/if}
						{#if it.color}
							<span class="size-2.5 shrink-0 rounded-full" style={`background:${it.color}`}></span>
						{/if}
						<span class="flex-1">{it.label}</span>
						{#if it.hint}
							<span class="text-muted-foreground shrink-0 font-mono text-[10px]">{it.hint}</span>
						{/if}
					</button>
				</li>
			{:else}
				<li class="text-muted-foreground px-3 py-6 text-center text-sm">Nichts gefunden.</li>
			{/each}
		</ul>
	</Dialog.Content>
</Dialog.Root>
