<script lang="ts">
	import { app } from "$lib/app.svelte";
	import { durationSeconds, fmtClock, fmtDate, fmtHMS } from "$lib/time";
	import { START_PRESETS, resolveStartTs, toStartArg } from "$lib/startTime";
	import { Button } from "$lib/components/ui/button";
	import { Input } from "$lib/components/ui/input";
	import * as Card from "$lib/components/ui/card";
	import { toast } from "svelte-sonner";
	import SquareIcon from "@lucide/svelte/icons/square";
	import PlayIcon from "@lucide/svelte/icons/play";
	import StarIcon from "@lucide/svelte/icons/star";

	let onlyFavorites = $state(false);
	const choices = $derived(
		onlyFavorites ? app.trackableActivities.filter((a) => a.favorite) : app.trackableActivities
	);

	// Startzeit-Auswahl: Preset "vor X min" (0 = jetzt) oder freie Uhrzeit (überschreibt Preset).
	let presetMin = $state(0);
	let customStart = $state("");

	// Hinweistext (tickt mit app.now); null wenn "jetzt" oder ungültig.
	const startHint = $derived.by(() => {
		void app.now;
		if (!customStart && presetMin === 0) return null;
		const ts = resolveStartTs(presetMin, customStart);
		if (ts == null) return "ungültige Uhrzeit";
		return `Timer beginnt um ${fmtClock(ts)}`;
	});

	function startAt(activityId: string) {
		const now = Date.now();
		const ts = resolveStartTs(presetMin, customStart, now);
		if (ts == null) {
			toast.error("Ungültige Startzeit (liegt in der Zukunft?).");
			return;
		}
		void app.startActivity(activityId, toStartArg(ts, now));
		// Nach dem Start auf "jetzt" zurücksetzen.
		presetMin = 0;
		customStart = "";
	}

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
						{#if app.pomodoro}
							{@const p = app.pomodoro}
							<div
								class="mt-2 inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium {p.phase ===
								'break'
									? 'bg-green-500/15 text-green-600 dark:text-green-400'
									: 'bg-primary/10 text-primary'}"
							>
								{p.phase === "break" ? "Pause" : "Fokus"} · noch {fmtHMS(p.remaining)}
							</div>
						{/if}
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

	{#if !app.running}
		<div class="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border p-2 text-sm">
			<span class="text-muted-foreground font-medium">Startzeit</span>
			<div class="flex flex-wrap items-center gap-1">
				<button
					type="button"
					class="hover:bg-accent rounded px-2 py-1 {presetMin === 0 && !customStart
						? 'bg-accent font-medium'
						: ''}"
					onclick={() => {
						presetMin = 0;
						customStart = "";
					}}
				>
					Jetzt
				</button>
				{#each START_PRESETS as m (m)}
					<button
						type="button"
						class="hover:bg-accent rounded px-2 py-1 {presetMin === m && !customStart
							? 'bg-accent font-medium'
							: ''}"
						onclick={() => {
							presetMin = m;
							customStart = "";
						}}
					>
						−{m} min
					</button>
				{/each}
			</div>
			<div class="flex items-center gap-1.5">
				<span class="text-muted-foreground text-xs">oder ab</span>
				<Input
					type="time"
					bind:value={customStart}
					class="h-8 w-24"
					oninput={() => (presetMin = 0)}
				/>
			</div>
			{#if startHint}
				<span class="text-muted-foreground text-xs">· {startHint}</span>
			{/if}
		</div>
	{/if}

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
						onclick={() => (active ? app.stop() : startAt(a.id))}
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
