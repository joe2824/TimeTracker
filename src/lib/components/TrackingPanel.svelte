<script lang="ts">
	import { app } from "$lib/app.svelte";
	import {
		durationSeconds,
		entryHours,
		fmtClock,
		fmtDate,
		fmtDateHuman,
		fmtHMS,
		fmtHoursClock,
		midnightSplitHint,
		noonTs
	} from "$lib/time";
	import { breakDeduction } from "$lib/breaks";
	import { arbzgMonths, checkArbZg, dataFromEntries, MIN_HINT_WEEKS } from "$lib/arbzg";
	import { START_PRESETS, resolveStartTs, toStartArg } from "$lib/startTime";
	import { Button } from "$lib/components/ui/button";
	import * as ButtonGroup from "$lib/components/ui/button-group";
	import { Input } from "$lib/components/ui/input";
	import * as Card from "$lib/components/ui/card";
	import { toast } from "svelte-sonner";
	import SquareIcon from "@lucide/svelte/icons/square";
	import PlayIcon from "@lucide/svelte/icons/play";
	import StarIcon from "@lucide/svelte/icons/star";
	import ListIcon from "@lucide/svelte/icons/list";
	import XIcon from "@lucide/svelte/icons/x";
	import ActivityDot from "$lib/components/ActivityDot.svelte";
	import TriangleAlertIcon from "@lucide/svelte/icons/triangle-alert";
	import ChevronRightIcon from "@lucide/svelte/icons/chevron-right";

	let {
		onShowEntries,
		onShowReport
	}: { onShowEntries?: () => void; onShowReport?: () => void } = $props();


	let onlyFavorites = $state(false);
	const choices = $derived(
		onlyFavorites ? app.trackableActivities.filter((a) => a.favorite) : app.trackableActivities
	);

	// Startzeit-Auswahl: Preset "vor X min" (0 = jetzt) oder freie Uhrzeit (überschreibt Preset).
	let presetMin = $state(0);
	let customStart = $state("");
	let clockInput = $state<HTMLInputElement | null>(null);
	/** Gilt gerade die freie Uhrzeit? Steuert Hervorhebung UND Auswertung. */
	const usingClock = $derived(customStart !== "");

	// Hinweistext (tickt mit app.now); null wenn "jetzt".
	const startHint = $derived.by(() => {
		if (!customStart && presetMin === 0) return null;
		const now = app.now;
		const ts = resolveStartTs(presetMin, customStart, now);
		if (ts == null) return "unlesbare Uhrzeit";
		const geteilt = midnightSplitHint(ts, now);
		if (geteilt) return `beginnt ${fmtDateHuman(ts)} um ${fmtClock(ts)} – ${geteilt}`;
		return `Timer beginnt um ${fmtClock(ts)}`;
	});

	function startAt(activityId: string) {
		const now = Date.now();
		const ts = resolveStartTs(presetMin, customStart, now);
		if (ts == null) {
			toast.error("Unlesbare Startzeit.");
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

	// ---- Arbeitszeit-Hinweis ----
	// Stichtag ist `today` (siehe oben): aus `app.now`, aber formatiert. `app.now`
	// tickt im Sekundentakt, die formatierte Fassung aendert sich nur um
	// Mitternacht, und einen unveraenderten Wert gibt Svelte nicht weiter – die
	// Rechnung laeuft also einmal am Tag und ueberlebt trotzdem den Tageswechsel.
	const hintOn = $derived(app.settings.arbzgTrackingHint);
	const hintMonths = $derived(hintOn ? arbzgMonths(today) : []);

	$effect(() => {
		for (const m of hintMonths) void app.ensureMonth(m);
	});

	const hintEntries = $derived(hintMonths.flatMap((m) => app.monthEntries(m)));

	// Erst urteilen, wenn ALLE zwoelf Monate da sind. Waehrend des Ladens liefert
	// `monthEntries` fuer noch nicht geladene Monate eine leere Liste – der
	// Hinweis saehe beim Start also nur den laufenden Monat und meldete einem
	// Vielarbeiter zuverlaessig ein rotes "Grenze bereits gerissen", das eine
	// Sekunde spaeter wieder verschwindet.
	const hintReady = $derived(hintMonths.every((m) => app.monthLoaded(m)));

	const arbzgVerdict = $derived.by(() => {
		if (!hintOn || !hintReady || hintEntries.length === 0) return null;
		const r = checkArbZg(hintEntries, {
			until: today,
			dataFrom: dataFromEntries(hintEntries, today),
			workdays: app.settings.workdays,
			deductBreaks: app.settings.breakDeduction,
			absenceIds: new Set(app.activities.filter((a) => a.isAbsence).map((a) => a.id)),
			// Nicht `app.now`: sonst haengt die ganze Rechnung am Sekundentakt. Die
			// laufende Stunde verschiebt einen 24-Wochen-Schnitt ohnehin nicht.
			now: noonTs(today)
		});
		// Die Card darf ueber eine kurze Datenbasis rechnen, weil sie sie
		// ausweist ("erst 16 von 24 Wochen") und weil man sie aufsucht. Ein
		// Hinweis, der von selbst erscheint, darf das nicht: aus einem einzigen
		// erfassten Monat wuerde sonst eine Warnung, die nur heisst, dass die
		// uebrigen fuenf fehlen.
		const w = r.windows.strict;
		if (!w.complete && w.weeksCovered < MIN_HINT_WEEKS) return null;
		const v = r.forecasts.strict.verdict;
		// Nur wenn wirklich etwas zu tun ist – also wenn man spuerbar herunter
		// muesste, um das Fenster zu halten. "Dicht an der Grenze" bleibt der Card
		// vorbehalten: eine Dauerwarnung auf der meistgesehenen Seite liest nach
		// einer Woche niemand mehr, und dann faellt auch die nicht mehr auf, die
		// etwas von einem will.
		return v.requiresAction ? v : null;
	});

	/** Tagesbilanz: erfasst, Pausenabzug, Arbeitszeit. */
	const todaySum = $derived.by(() => {
		let worked = 0;
		let absent = 0;
		for (const e of todayEntries) {
			const isAbs = app.isAbsenceId(e.activityId);
			const h = entryHours(e, isAbs, app.settings.hoursPerDay, app.now);
			if (isAbs) absent += h;
			else worked += h;
		}
		const pause = app.settings.breakDeduction ? breakDeduction(worked) : 0;
		return { worked, absent, pause, net: worked - pause };
	});
</script>

<div class="space-y-4">
	{#if arbzgVerdict}
		<!-- Eine Zeile, kein zweiter Bericht: die Zahlen stehen im Tab „Bericht".
		     Verlinkt wird aber nur, wenn es die Karte dort auch gibt – beide
		     Schalter sind unabhaengig, und ein Klick ins Leere ist schlimmer als
		     kein Klick. -->
		{#if app.settings.arbzgEnabled}
			<button
				class="hint flex w-full items-center gap-2 rounded-md border px-3 py-1.5 text-left text-xs"
				class:hint-crit={arbzgVerdict.level === "crit"}
				onclick={() => onShowReport?.()}
			>
				<TriangleAlertIcon class="size-3.5 shrink-0" />
				<span class="font-medium">{arbzgVerdict.headline}</span>
				<span class="text-muted-foreground truncate">· Arbeitszeit-Check</span>
				<ChevronRightIcon class="ml-auto size-3.5 shrink-0 opacity-60" />
			</button>
		{:else}
			<div
				class="hint flex w-full items-center gap-2 rounded-md border px-3 py-1.5 text-xs"
				class:hint-crit={arbzgVerdict.level === "crit"}
			>
				<TriangleAlertIcon class="size-3.5 shrink-0" />
				<span class="font-medium">{arbzgVerdict.headline}</span>
				<span class="text-muted-foreground truncate">· Arbeitszeit-Check</span>
			</div>
		{/if}
	{/if}

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
			<!-- Eine Auswahl aus vier Möglichkeiten: die gewählte ist hervorgehoben,
			     „ab Uhrzeit" eingeschlossen. -->
			<ButtonGroup.Root>
				<Button
					variant={usingClock || presetMin !== 0 ? "outline" : "default"}
					size="sm"
					onclick={() => {
						presetMin = 0;
						customStart = "";
					}}
				>
					Jetzt
				</Button>
				{#each START_PRESETS as m (m)}
					<Button
						variant={!usingClock && presetMin === m ? "default" : "outline"}
						size="sm"
						onclick={() => {
							presetMin = m;
							customStart = "";
						}}
					>
						−{m} min
					</Button>
				{/each}
				<Button
					variant={usingClock ? "default" : "outline"}
					size="sm"
					title="Ab einer bestimmten Uhrzeit starten"
					onclick={() => {
						// Mit der aktuellen Zeit vorbelegen, damit das Feld nie leer aktiv ist.
						if (!customStart) customStart = fmtClock(Date.now());
						presetMin = 0;
						clockInput?.focus();
					}}
				>
					ab Uhrzeit
				</Button>
			</ButtonGroup.Root>
			{#if usingClock}
				<div class="flex items-center gap-1.5">
					<Input
						bind:ref={clockInput}
						type="time"
						bind:value={customStart}
						class="h-7 w-24"
						oninput={() => (presetMin = 0)}
					/>
					<Button
						variant="ghost"
						size="icon-sm"
						title="Uhrzeit verwerfen"
						onclick={() => (customStart = "")}
					>
						<XIcon />
					</Button>
				</div>
			{/if}
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
						<ActivityDot color={a.color} />
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
		<Card.Header class="flex flex-row items-start justify-between gap-2 space-y-0">
			<div class="min-w-0">
				<Card.Title>Heute ({today})</Card.Title>
				{#if todaySum.worked > 0 || todaySum.absent > 0}
					<!-- Kleine Tagesbilanz: erfasst, Abzug, Arbeitszeit. Ohne sie muesste
					     man die Zeilen darunter im Kopf zusammenrechnen – und der
					     Pausenabzug waere gar nicht zu sehen. -->
					<p class="text-muted-foreground mt-0.5 font-mono text-xs tabular-nums">
						Σ {fmtHoursClock(todaySum.worked)} h erfasst
						{#if todaySum.pause > 0}
							· −{fmtHoursClock(todaySum.pause)} Pause ·
							<span class="text-foreground font-medium">{fmtHoursClock(todaySum.net)} h Arbeitszeit</span>
						{/if}
						{#if todaySum.absent > 0}
							· {fmtHoursClock(todaySum.absent)} h Abwesenheit
						{/if}
					</p>
				{/if}
			</div>
			<Button variant="outline" size="sm" class="shrink-0" onclick={() => onShowEntries?.()}>
				<ListIcon class="size-4" /> Einträge anzeigen
			</Button>
		</Card.Header>
		<Card.Content>
			{#if todayEntries.length === 0}
				<p class="text-muted-foreground text-sm">Heute noch nichts erfasst.</p>
			{:else}
				<ul class="divide-border divide-y text-sm">
					{#each todayEntries as e (e.id)}
						{@const isAbs = app.isAbsenceId(e.activityId)}
						<li class="flex items-center justify-between gap-2 py-1.5">
							<span class="flex min-w-0 items-center gap-2">
								<ActivityDot color={app.activityColor(e.activityId)} />
								<span class="truncate">{app.activityName(e.activityId)}</span>
							</span>
							<span class="text-muted-foreground shrink-0 font-mono tabular-nums">
								{#if isAbs}
									<!-- Abwesenheiten sind tagesgenau: start == end. Als Uhrzeitspanne
									     stand hier „12:00–12:00 (0:00:00)" – während die Tagesbilanz
									     oben den Tagessatz mitzählt. -->
									{(e.dayFraction ?? 1) === 0.5 ? "½ Tag" : "ganzer Tag"}
									&nbsp;({fmtHoursClock((e.dayFraction ?? 1) * app.settings.hoursPerDay)} h)
								{:else}
									{fmtClock(e.startTs)}–{e.endTs ? fmtClock(e.endTs) : "…"}
									&nbsp;({fmtHMS(durationSeconds(e, app.now))})
								{/if}
							</span>
						</li>
					{/each}
				</ul>
			{/if}
		</Card.Content>
	</Card.Root>
</div>

<style>
	/* Gedeckt gehalten: der Hinweis steht ueber dem Timer und darf ihn nicht
	   uebertoenen – er soll auffallen, wenn man hinsieht, nicht bevor. */
	.hint {
		border-color: color-mix(in oklab, #f59e0b 55%, transparent);
		background: color-mix(in oklab, #f59e0b 7%, transparent);
		color: #b45309;
	}
	.hint-crit {
		border-color: color-mix(in oklab, var(--destructive) 50%, transparent);
		background: color-mix(in oklab, var(--destructive) 6%, transparent);
		color: var(--destructive);
	}
	:global(.dark) .hint {
		color: #fbbf24;
	}
	:global(.dark) .hint-crit {
		color: var(--destructive);
	}
</style>
