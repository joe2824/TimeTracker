<script lang="ts">
	import { app } from "$lib/app.svelte";
	import { durationSeconds, fmtClock, fmtDate, fmtHMS } from "$lib/time";
	import { Button } from "$lib/components/ui/button";
	import * as Card from "$lib/components/ui/card";
	import SquareIcon from "@lucide/svelte/icons/square";
	import PlayIcon from "@lucide/svelte/icons/play";
	import StarIcon from "@lucide/svelte/icons/star";

	let onlyFavorites = $state(false);
	const choices = $derived(
		onlyFavorites ? app.trackableActivities.filter((a) => a.favorite) : app.trackableActivities
	);

	const today = $derived(fmtDate(app.now));
	const todayEntries = $derived(
		app
			.monthEntries(app.currentMonth)
			.filter((e) => fmtDate(e.startTs) === today)
			.sort((a, b) => b.startTs - a.startTs)
	);
</script>

<div class="space-y-4">
	<Card.Root>
		<Card.Header>
			<Card.Title>Aktueller Timer</Card.Title>
		</Card.Header>
		<Card.Content>
			{#if app.running}
				<div class="flex items-center justify-between">
					<div>
						<div class="text-lg font-medium">{app.activityName(app.running.activityId)}</div>
						<div class="text-muted-foreground text-3xl font-mono tabular-nums">
							{fmtHMS(app.runningSeconds)}
						</div>
						<div class="text-muted-foreground text-xs">seit {fmtClock(app.running.startTs)}</div>
					</div>
					<Button variant="destructive" onclick={() => app.stop()}>
						<SquareIcon class="size-4" /> Stopp
					</Button>
				</div>
			{:else}
				<p class="text-muted-foreground">Kein Timer läuft. Wähle unten eine Aktivität.</p>
			{/if}
		</Card.Content>
	</Card.Root>

	<div>
		<div class="mb-2 flex items-center justify-between">
			<h3 class="text-sm font-medium">Aktivität wählen</h3>
			{#if app.hasFavorites}
				<Button
					variant={onlyFavorites ? "default" : "ghost"}
					size="sm"
					onclick={() => (onlyFavorites = !onlyFavorites)}
				>
					<StarIcon class="size-4" /> Nur Favoriten
				</Button>
			{/if}
		</div>
		{#if choices.length === 0}
			<p class="text-muted-foreground text-sm">
				{#if app.trackableActivities.length === 0}
					Noch keine Aktivitäten. Lege sie im Tab „Aktivitäten“ an oder importiere die Liste.
				{:else}
					Keine Favoriten markiert. Markiere welche im Tab „Aktivitäten“.
				{/if}
			</p>
		{:else}
			<div class="grid grid-cols-2 gap-2 sm:grid-cols-3">
				{#each choices as a (a.id)}
					{@const active = app.running?.activityId === a.id}
					<Button
						variant={active ? "default" : "outline"}
						class="h-auto justify-start whitespace-normal py-2 text-left"
						onclick={() => (active ? app.stop() : app.startActivity(a.id))}
					>
						{#if active}
							<SquareIcon class="size-4 shrink-0" />
						{:else}
							<PlayIcon class="size-4 shrink-0" />
						{/if}
						{#if a.color}
							<span class="size-2.5 shrink-0 rounded-full" style={`background:${a.color}`}></span>
						{/if}
						<span class="flex-1">{a.name}</span>
						{#if a.shortcut}
							<span class="shrink-0 font-mono text-[10px] opacity-60">{a.shortcut}</span>
						{/if}
						{#if a.favorite}
							<StarIcon class="size-3.5 shrink-0 fill-yellow-400 text-yellow-400" />
						{/if}
					</Button>
				{/each}
			</div>
		{/if}
	</div>

	<Card.Root>
		<Card.Header>
			<Card.Title>Heute ({today})</Card.Title>
		</Card.Header>
		<Card.Content>
			{#if todayEntries.length === 0}
				<p class="text-muted-foreground text-sm">Heute noch nichts erfasst.</p>
			{:else}
				<ul class="divide-border divide-y text-sm">
					{#each todayEntries as e (e.id)}
						<li class="flex items-center justify-between py-1.5">
							<span class="flex items-center gap-2">
								{#if app.activityColor(e.activityId)}
									<span
										class="size-2.5 shrink-0 rounded-full"
										style={`background:${app.activityColor(e.activityId)}`}
									></span>
								{/if}
								{app.activityName(e.activityId)}
							</span>
							<span class="text-muted-foreground font-mono tabular-nums">
								{fmtClock(e.startTs)}–{e.endTs ? fmtClock(e.endTs) : "…"}
								&nbsp;({fmtHMS(durationSeconds(e, app.now))})
							</span>
						</li>
					{/each}
				</ul>
			{/if}
		</Card.Content>
	</Card.Root>
</div>
