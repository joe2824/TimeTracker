<script lang="ts">
	import { onMount } from "svelte";
	import { app } from "$lib/app.svelte";
	import { fmtHMS } from "$lib/time";
	import { Button } from "$lib/components/ui/button";
	import { getCurrentWindow } from "@tauri-apps/api/window";
	import { Window } from "@tauri-apps/api/window";
	import { emit } from "@tauri-apps/api/event";
	import SquareIcon from "@lucide/svelte/icons/square";
	import PlayIcon from "@lucide/svelte/icons/play";
	import StarIcon from "@lucide/svelte/icons/star";
	import ExternalLinkIcon from "@lucide/svelte/icons/external-link";

	const win = getCurrentWindow();

	// Schnellstart: Favoriten zuerst, dann zuletzt benutzte.
	const quick = $derived.by(() => {
		const out: { id: string; name: string; color?: string; favorite: boolean }[] = [];
		const seen = new Set<string>();
		const push = (a: { id: string; name: string; color?: string; favorite?: boolean }) => {
			if (seen.has(a.id)) return;
			seen.add(a.id);
			out.push({ id: a.id, name: a.name, color: a.color, favorite: !!a.favorite });
		};
		for (const a of app.trackableActivities) if (a.favorite) push(a);
		for (const a of app.recentActivities(8)) push(a);
		return out.slice(0, 8);
	});

	async function refresh() {
		await app.reload();
	}

	onMount(() => {
		void refresh();
		// Eigener Tick (dieses Fenster ruft app.init() nicht auf) für die Live-Anzeige.
		const tick = setInterval(() => (app.now = Date.now()), 1000);
		// Bei jedem Einblenden (Fokus) frische Daten laden.
		const un = win.onFocusChanged(({ payload }) => {
			if (payload) void refresh();
		});
		return () => {
			clearInterval(tick);
			void un.then((f) => f());
		};
	});

	async function start(id: string) {
		await app.startActivity(id);
		await emit("data-reload"); // Hauptfenster aktualisieren + Tray-Menü/Icon
		// Flyout bleibt offen; schließt erst bei Fokusverlust.
	}
	async function stop() {
		await app.stop();
		await emit("data-reload");
	}
	async function openMain() {
		const main = await Window.getByLabel("main");
		await main?.show();
		await main?.unminimize();
		await main?.setFocus();
		await win.hide();
	}
</script>

<div class="bg-background text-foreground flex h-screen flex-col gap-3 p-3 text-sm">
	{#if app.running}
		<div class="border-primary/20 bg-primary/10 flex h-17 items-center justify-between gap-2 rounded-lg border p-3">
			<div class="min-w-0">
				<div class="truncate font-medium">{app.activityName(app.running.activityId)}</div>
				<div class="text-primary font-mono text-lg tabular-nums">{fmtHMS(app.runningSeconds)}</div>
			</div>
			<Button variant="destructive" size="sm" onclick={stop}>
				<SquareIcon class="size-4" /> Stopp
			</Button>
		</div>
	{:else}
		<div class="text-muted-foreground flex h-17 items-center justify-center rounded-lg border border-dashed p-3 text-center text-xs">
			Kein Timer läuft
		</div>
	{/if}

	<div class="text-muted-foreground text-xs font-medium">Schnellstart</div>
	<div class="-mr-1 flex-1 space-y-1 overflow-y-auto pr-1">
		{#each quick as a (a.id)}
			{@const active = app.running?.activityId === a.id}
			<button
				type="button"
				class="hover:bg-accent flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left {active
					? 'bg-accent'
					: ''}"
				onclick={() => (active ? stop() : start(a.id))}
			>
				{#if active}
					<SquareIcon class="size-4 shrink-0" />
				{:else}
					<PlayIcon class="size-4 shrink-0" />
				{/if}
				{#if a.color}
					<span class="size-2.5 shrink-0 rounded-full" style={`background:${a.color}`}></span>
				{/if}
				<span class="flex-1 truncate">{a.name}</span>
				{#if a.favorite}
					<StarIcon class="size-3.5 shrink-0 fill-yellow-400 text-yellow-400" />
				{/if}
			</button>
		{:else}
			<p class="text-muted-foreground px-2 text-xs">Keine Aktivitäten.</p>
		{/each}
	</div>

	<Button variant="outline" size="sm" class="w-full" onclick={openMain}>
		<ExternalLinkIcon class="size-4" /> App öffnen
	</Button>
</div>
