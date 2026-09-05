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
	import { TIME_OFF_COLOR } from "$lib/types";
	import { breakDeduction } from "$lib/breaks";
	import { dayTotals } from "$lib/dayTotals";
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
	import ActivityDot from "$lib/components/shared/ActivityDot.svelte";
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
		const shared = midnightSplitHint(ts, now);
		if (shared) return `beginnt ${fmtDateHuman(ts)} um ${fmtClock(ts)} – ${shared}`;
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

	/**
	 * Form und Toenung der Hinweiszeile.
	 *
	 * Gedeckt gehalten: der Hinweis steht ueber dem Timer und darf ihn nicht
	 * uebertoenen. Dieselben Stufen wie das Urteil im Arbeitszeit-Check, damit
	 * dieselbe Farbe dasselbe heisst.
	 */
	const HINT_FORM = "flex w-full items-center gap-2 rounded-lg border px-3 py-2 text-xs";
	const hintTone = $derived(
		arbzgVerdict?.level === "crit"
			? "border-destructive/50 bg-destructive/6 text-destructive"
			: "border-amber-500/55 bg-amber-500/7 text-amber-700 dark:text-amber-400"
	);

	const absenceIds = $derived(new Set(app.activities.filter((a) => a.isAbsence).map((a) => a.id)));
	const todaySum = $derived(
		dayTotals(todayEntries, absenceIds, app.settings.hoursPerDay, {
			now: app.now,
			deductBreaks: app.settings.breakDeduction
		})
	);
</script>

<div class="space-y-4">
	{#if arbzgVerdict}
		<!-- Eine Zeile, kein zweiter Bericht: die Zahlen stehen im Tab „Bericht".
		     Verlinkt wird aber nur, wenn es die Karte dort auch gibt – beide
		     Schalter sind unabhaengig, und ein Klick ins Leere ist schlimmer als
		     kein Klick. -->
		{#if app.settings.arbzgEnabled}
			<button
				class={[HINT_FORM, hintTone, "text-left transition-colors hover:brightness-[0.97]"]}
				onclick={() => onShowReport?.()}
			>
				<TriangleAlertIcon class="size-3.5 shrink-0" />
				<span class="font-medium">{arbzgVerdict.headline}</span>
				<span class="text-muted-foreground hidden truncate sm:inline">· Arbeitszeit-Check</span>
				<ChevronRightIcon class="ml-auto size-3.5 shrink-0 opacity-60" />
			</button>
		{:else}
			<div class={[HINT_FORM, hintTone]}>
				<TriangleAlertIcon class="size-3.5 shrink-0" />
				<span class="font-medium">{arbzgVerdict.headline}</span>
				<span class="text-muted-foreground hidden truncate sm:inline">· Arbeitszeit-Check</span>
			</div>
		{/if}
	{/if}

	<!--
		Der laufende Timer ist die Hauptaussage der Seite und traegt deshalb Farbe,
		solange er laeuft – vorher war er eine Karte wie jede andere, und ob
		ueberhaupt etwas lief, musste man lesen statt sehen. Steht er, bleibt die
		Karte bewusst still: dort gibt es nichts zu melden.
	-->
	<!-- Bewusst KEIN aria-live: die Uhr tickt im Sekundentakt und wuerde als
	     Live-Bereich jeden Screenreader zuschuetten. -->
	<Card.Root class={app.running ? "ring-primary/25 bg-primary/[0.04]" : ""}>
		<Card.Content class="py-1">
			{#if app.running}
				<div class="flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
					<div class="min-w-0">
						<div class="flex items-center gap-2">
							<!-- Derselbe pulsierende Punkt wie in der Kopfzeile: ein Zeichen,
							     eine Bedeutung. -->
							<span class="relative flex size-2 shrink-0">
								<span
									class="bg-primary absolute inline-flex size-full animate-ping rounded-full opacity-75"
								></span>
								<span class="bg-primary relative inline-flex size-2 rounded-full"></span>
							</span>
							<span class="truncate text-sm font-medium">
								{app.activityName(app.running.activityId)}
							</span>
						</div>
						<div class="mt-0.5 font-mono text-4xl leading-none tabular-nums">
							{fmtHMS(app.runningSeconds)}
						</div>
						<div class="text-muted-foreground mt-1.5 flex flex-wrap items-center gap-2 text-xs">
							<span>seit {fmtClock(app.running.startTs)}</span>
							{#if app.pomodoro}
								{@const p = app.pomodoro}
								<span
									class="inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 font-medium {p.phase ===
									'break'
										? 'bg-green-500/15 text-green-600 dark:text-green-400'
										: 'bg-primary/10 text-primary'}"
								>
									{p.phase === "break" ? "Pause" : "Fokus"} · noch {fmtHMS(p.remaining)}
								</span>
							{/if}
						</div>
					</div>
					<Button variant="destructive" size="lg" onclick={() => app.stop()}>
						<SquareIcon class="size-4" /> Stopp
					</Button>
				</div>
			{:else}
				<div class="flex items-center gap-3 py-1">
					<span class="bg-muted-foreground/30 size-2 shrink-0 rounded-full"></span>
					<p class="text-muted-foreground text-sm">
						Kein Timer läuft. Wähle unten eine Aktivität.
					</p>
				</div>
			{/if}
		</Card.Content>
	</Card.Root>

	{#if !app.running}
		<div class="bg-muted/40 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg px-3 py-2.5 text-sm">
			<span class="text-muted-foreground text-xs font-medium">Startzeit</span>
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
						title="Vor {m} Minuten"
						onclick={() => {
							presetMin = m;
							customStart = "";
						}}
					>
						<!-- Schmal nur "−15": die Einheit steht ueber der Leiste ("Startzeit"),
						     und ausgeschrieben sprengt die Gruppe bei 360px die Zeile. -->
						−{m}<span class="hidden sm:inline">&nbsp;min</span>
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
		<div class="mb-2 flex flex-wrap items-center justify-between gap-2">
			<div>
				<h3 class="text-sm font-medium">Aktivität wählen</h3>
				<p class="text-muted-foreground text-xs">Ein Klick startet den Timer.</p>
			</div>
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
			<!-- Eine Spalte erst ab ~420px verdoppeln: darunter bleibt neben Symbol,
			     Punkt und Stern kaum Platz fuer den Namen. -->
			<div class="grid grid-cols-1 gap-2 min-[420px]:grid-cols-2 sm:grid-cols-3">
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
		<Card.Header class="flex flex-row flex-wrap items-start justify-between gap-2 space-y-0">
			<div class="min-w-0">
				<Card.Title>Heute ({today})</Card.Title>
				{#if todaySum.worked > 0 || todaySum.absent > 0 || todaySum.timeOff > 0}
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
						{#if todaySum.timeOff > 0}
							· −{fmtHoursClock(todaySum.timeOff)} h Zeitausgleich
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
						{@const isTimeOff = app.isTimeOff(e)}
						<li class="flex items-center justify-between gap-2 py-1.5">
							<span class="flex min-w-0 items-center gap-2">
								<ActivityDot
									color={isTimeOff ? TIME_OFF_COLOR : app.activityColor(e.activityId)}
								/>
								<span class="truncate">
									{isTimeOff ? "Zeitausgleich" : app.activityName(e.activityId)}
								</span>
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


