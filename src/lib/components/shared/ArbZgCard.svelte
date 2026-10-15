<script lang="ts">
	import { app } from "$lib/app.svelte";
	import {
		arbzgMonths,
		arbzgUntil,
		AVG_TOLERANCE,
		checkArbZg,
		dataFromEntries,
		DEFAULT_PACE_WEEKS,
		NORM_DAILY,
		type ArbZgFinding,
		type ArbZgLevel,
		type WeekActual
	} from "$lib/time/arbzg";
	import { entriesFocus } from "$lib/ui/entriesFocus.svelte";
	import {
		fmtCalendarDate,
		fmtDate,
		fmtDateHuman,
		fmtHoursClock,
		MINUTE_MS,
		monthKey,
		monthLabel,
		noonTs,
		quantize,
		shiftMonthKey,
		stepDate
	} from "$lib/time/time";
	import { appTimeZone, zonedParts } from "$lib/time/tz";
	import type { Entry } from "$lib/types";
	import { Badge } from "$lib/components/ui/badge";
	import { Button } from "$lib/components/ui/button";
	import * as Card from "$lib/components/ui/card";
	import * as Chart from "$lib/components/ui/chart";
	import * as Popover from "$lib/components/ui/popover";
	import { Skeleton } from "$lib/components/ui/skeleton";
	import StatTile from "$lib/components/shared/StatTile.svelte";
	import { LineChart, Rect, Spline } from "layerchart";
	import { scaleTime } from "d3-scale";
	import TriangleAlertIcon from "@lucide/svelte/icons/triangle-alert";
	import InfoIcon from "@lucide/svelte/icons/info";
	import CheckIcon from "@lucide/svelte/icons/check";
	import ChevronRightIcon from "@lucide/svelte/icons/chevron-right";

	interface Props {
		/** ausgewählter Monat "YYYY-MM" */
		month: string;
	}
	let { month }: Props = $props();

	/** Referenzzeitraum für das angenommene Tempo (siehe DEFAULT_PACE_WEEKS). */
	let paceWeeks = $state(DEFAULT_PACE_WEEKS);

	// Stichtag: Monatsende, nie nach heute. An `app.now`, nicht an Date.now(): die
	// Anwendung läuft über Nacht, und der Stichtag muss mitwandern.
	const until = $derived(arbzgUntil(month, app.now));

	const monthsNeeded = $derived(arbzgMonths(until));

	$effect(() => {
		for (const m of monthsNeeded) void app.ensureMonth(m);
	});

	/** Sind alle zwölf Monate da? */
	const ready = $derived(monthsNeeded.every((m) => app.monthLoaded(m)));

	const entries = $derived(monthsNeeded.flatMap((m) => app.monthEntries(m) as Entry[]));

	const dataFrom = $derived(dataFromEntries(entries, until));

	// Wie in StatsCard: `app.now` tickt im Sekundentakt und würde die ganze
	// Rechnung samt Kurve jede Sekunde neu aufbauen. Nur ein laufender Timer
	// braucht ihn; sonst haben alle Einträge ein Ende und lesen `now` gar nicht.
	const runningToday = $derived(app.running !== null && fmtDate(app.running.startTs) === until);
	// Auf Minuten gerundet. Ein Schnitt über 24 Wochen bewegt sich in einer
	// Sekunde um nichts Sichtbares – ohne die Rundung liefen dayFacts, beide
	// Fenster, beide Prognosen samt Umkehrpunkt-Suche und die komplette Kurve
	// sechzigmal je Minute neu, nur weil ein Timer läuft (gemessen: 4 ms je
	// Durchlauf, dazu das Neuzeichnen des Diagramms).
	const checkNow = $derived(runningToday ? quantize(app.now, MINUTE_MS) : noonTs(until));

	const result = $derived(
		checkArbZg(entries, {
			until,
			dataFrom,
			workdays: app.settings.workdays,
			deductBreaks: app.settings.breakDeduction,
			absenceIds: app.absenceIds,
			now: checkNow,
			paceWeeks
		})
	);

	const strict = $derived(result.forecasts.strict);
	const legal = $derived(result.legal);
	const strictWindow = $derived(result.windows.strict);
	const legalWindow = $derived(result.windows.legal);
	const strictOver = $derived(strictWindow.average > NORM_DAILY + AVG_TOLERANCE);

	/** "TT.MM.", mit Jahr nur, wenn es nicht das des Stichtags ist - "22.02." sähe sonst nach übermorgen aus. */
	function shortDate(iso: string): string {
		return fmtCalendarDate(
			iso,
			iso.slice(0, 4) === until.slice(0, 4)
				? { day: "2-digit", month: "2-digit" }
				: { day: "2-digit", month: "2-digit", year: "2-digit" }
		);
	}

	// Rot nur wie das Urteil: ein Schnitt, der allein auf die eigenen Arbeitstage
	// gerechnet über acht Stunden liegt, ist gelb - dann darf die Zahl nicht rot leuchten.
	// Die gesetzliche Grenze gerissen ist dagegen immer rot.
	const alarm = $derived(
		legal.over || (strict.verdict.requiresAction && strict.verdict.level === "crit")
	);

	// Hinweiszeile zur Kachel „Dauerhaft höchstens“: wie weit der zulässige
	// Tagesschnitt vom eigenen Tempo entfernt ist.
	const maxPaceHint = $derived.by(() => {
		const maxPace = strict.maxPace;
		const paceDelta = strict.paceDelta;
		if (maxPace === null || maxPace <= 0 || paceDelta === null) {
			return "je Arbeitstag, damit der Schnitt unter 8 h bleibt";
		}
		if (Math.abs(maxPace - NORM_DAILY) <= AVG_TOLERANCE) return "je Arbeitstag – die Grenze selbst";
		if (maxPace > NORM_DAILY + AVG_TOLERANCE) {
			return "je Arbeitstag – mehr als die Grenze, die letzten Wochen geben Luft";
		}
		return `je Arbeitstag, ${fmtHoursClock(Math.abs(paceDelta))} h ${paceDelta < 0 ? "unter" : "über"} deinem Tempo`;
	});

	// ---- Diagramm ----
	// Nur die STRENGE Rechnung ins Diagramm. Die gesetzliche liegt bei einer
	// Fünf-Tage-Woche rund zwei Stunden tiefer; zusammen in einem Achsenbereich
	// wird aus dem Anlaufen an die Grenze ein flacher Strich, und genau das ist
	// die Bewegung, um die es geht. Ihre Aussage steht als Zeile darüber.

	// `app.now` tickt im Sekundentakt; `$derived` reicht nur einen geänderten
	// WERT weiter, deshalb baut sich das Diagramm nicht je Tick neu auf.
	const isToday = $derived(until === fmtDate(app.now));
	const untilLabel = $derived(isToday ? "heute" : shortDate(until));
	const untilTs = $derived(new Date(noonTs(until)));
	const weekdayLabel = $derived(fmtCalendarDate(until, { weekday: "long" }));

	const DAY_MS = 86_400_000;
	const startOf = (iso: string) => new Date(noonTs(iso) - DAY_MS / 2);
	const endOf = (iso: string) => new Date(noonTs(iso) + DAY_MS / 2);
	const centreOf = (w: WeekActual) => noonTs(stepDate(w.from, 3));
	const hasValue = (w: WeekActual): w is WeekActual & { hoursPerWorkday: number } =>
		w.hoursPerWorkday !== null;

	// Ohne feste Domain nimmt das Diagramm die Null mit auf – die halbe Höhe
	// wäre dann leer und die entscheidenden Zehntel um die 8 h unsichtbar.
	// Blöcke mit weniger als zwei Arbeitstagen würden die Achse stauchen.
	const yDomain = $derived.by((): [number, number] => {
		const values = [
			NORM_DAILY,
			...strict.points.map((p) => p.average),
			...result.weeks.filter(hasValue).filter((w) => w.workdays >= 2).map((w) => w.hoursPerWorkday)
		];
		return [Math.min(...values) - 0.25, Math.max(...values) + 0.25];
	});
	const clampY = (v: number) => Math.min(yDomain[1], Math.max(yDomain[0], v));

	const bars = $derived(
		result.weeks.filter(hasValue).map((w) => ({
			ts: new Date(centreOf(w)),
			x0: startOf(w.from),
			x1: endOf(w.to),
			week: clampY(w.hoursPerWorkday),
			limit: NORM_DAILY
		}))
	);
	const barsOver = $derived(bars.filter((b) => b.week > NORM_DAILY));
	const barsUnder = $derived(bars.filter((b) => b.week < NORM_DAILY));

	const forecastRows = $derived(
		strict.points.map((p) => ({ ts: new Date(noonTs(p.date)), average: p.average, limit: NORM_DAILY }))
	);

	type ChartRow = { ts: Date; week?: number; average?: number; limit: number };
	// `limit` auf jeder Zeile, damit die 8-h-Linie über die ganze Breite läuft. Die
	// Balkenobjekte selbst, nicht Kopien: die Rechtecke melden ihre Daten eigens an,
	// und beim Hover gewinnt das zuletzt eingetragene Objekt desselben Zeitpunkts.
	const chartData = $derived<ChartRow[]>([...bars, ...forecastRows]);

	const blockByTs = $derived(new Map(result.weeks.map((w) => [centreOf(w), w])));

	const xDomain = $derived.by((): [Date, Date] => {
		const first = result.weeks.find((w) => w.workdays > 0)?.from ?? stepDate(until, -6);
		return [startOf(first), forecastRows.at(-1)?.ts ?? endOf(until)];
	});

	/** Monatserste als Achsenmarken. */
	const monthTicks = $derived.by(() => {
		const out: Date[] = [];
		const [first, last] = xDomain;
		// Monatsschlüssel statt Date-Cursor: der Monatserste hängt sonst an der
		// Zone des Geräts und die Marken sässen neben den Datenpunkten.
		let key = monthKey(first.getTime());
		const tickAt = (k: string) => new Date(noonTs(`${k}-01`));
		if (tickAt(key) < first) key = shiftMonthKey(key, 1);
		for (let t = tickAt(key); t <= last; key = shiftMonthKey(key, 1), t = tickAt(key)) out.push(t);
		return out;
	});

	// Das Jahr nur im Januar – sonst steht es sechsmal da, wo es niemand braucht.
	const tickLabel = (d: Date) => {
		const month = zonedParts(d.getTime()).month;
		return d.toLocaleDateString("de-DE", {
			timeZone: appTimeZone(),
			...(month === 1 ? { month: "short", year: "2-digit" } : { month: "short" })
		});
	};

	/** Wochenblock als Zeitraum, Prognosepunkt als Datum. */
	function tooltipLabel(value: unknown): string {
		const ts = new Date(value as string | number | Date).getTime();
		const w = blockByTs.get(ts);
		if (!w) return fmtDateHuman(ts);
		const day = (iso: string) => fmtCalendarDate(iso, { day: "numeric", month: "short" });
		return `${day(w.from)} – ${day(w.to)}`;
	}

	const BLUE = { light: "#2a78d6", dark: "#6ea6ec" };
	const chartConfig = {
		week: { label: "Je Arbeitstag", theme: BLUE },
		average: { label: "24-Wochen-Schnitt", theme: BLUE },
		limit: { label: "Grenze", theme: { light: "#dc2626", dark: "#f87171" } }
	} satisfies Chart.ChartConfig;

	// ---- Befunde ----
	const LEVEL_ORDER: Record<ArbZgLevel, number> = { violation: 0, risk: 1, hint: 2 };
	const byDay = $derived.by(() => {
		const map = new Map<string, ArbZgFinding[]>();
		for (const f of result.findings) {
			const list = map.get(f.date) ?? [];
			list.push(f);
			map.set(f.date, list);
		}
		return [...map.entries()]
			.map(([date, findings]) => ({
				date,
				findings: [...findings].sort((a, b) => LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level])
			}))
			.sort((a, b) => a.date.localeCompare(b.date));
	});

	const badgeVariant = (level: ArbZgLevel) =>
		level === "violation" ? ("destructive" as const) : ("outline" as const);

	function openDay(date: string) {
		entriesFocus.requestDate(date);
	}
</script>

{#snippet tooltipRow({ value, name }: { value: unknown; name: string })}
	<span class="text-muted-foreground">{name}</span>
	<span class="text-foreground ml-auto font-medium tabular-nums">
		{fmtHoursClock(Number(value))} h
	</span>
{/snippet}

<Card.Root id="arbzg-check" class="scroll-mt-20 py-4">
	<Card.Header>
		<Card.Title>Arbeitszeit-Check</Card.Title>
		<Card.Description>
			Schätzung nach dem Arbeitszeitgesetz auf Basis der erfassten Zeiten – nur für dich, nicht Teil
			der E-Mail.
		</Card.Description>
	</Card.Header>
	<Card.Content class="space-y-8">
		{#if !ready}
			<!-- Platzhalter im Zuschnitt des fertigen Inhalts: Urteil, sechs
			     Kennzahlen, Verlauf. So springt beim Erscheinen nichts. -->
			<div class="space-y-3">
				<Skeleton class="h-24 w-full" />
				<div class="grid grid-cols-2 gap-3 sm:grid-cols-3">
					{#each [0, 1, 2, 3, 4, 5] as i (i)}
						<Skeleton class="h-19 w-full" />
					{/each}
				</div>
				<Skeleton class="h-3 w-3/4" />
			</div>
			<div class="space-y-2">
				<Skeleton class="h-4 w-40" />
				<Skeleton class="h-65 w-full" />
			</div>
		{:else}
		<!-- Das Urteil zuerst: die Frage lautet "muss ich etwas tun?", und die
		     muss vor jeder Zahl beantwortet sein. -->
		<div class="space-y-3">
			<div class="flex flex-wrap items-start justify-between gap-3">
				<!-- Die gesetzliche Lesart steht zuerst, die Frühwarnung je Arbeitstag
				     darunter. Farbe bedeutet Handlungsbedarf, sonst nichts – eine
				     gerissene gesetzliche Grenze ist immer rot. -->
				<div
					class={[
						"flex flex-1 items-start gap-3 rounded-md border px-4 py-3",
						alarm
							? "border-destructive/50 bg-destructive/6 text-destructive"
							: strict.verdict.requiresAction &&
								"border-amber-500/55 bg-amber-500/7 text-amber-700 dark:text-amber-400"
					]}
				>
					{#if legal.over || strict.verdict.requiresAction}
						<TriangleAlertIcon class="mt-0.5 size-5 shrink-0" />
					{:else if strict.verdict.level === "ok"}
						<CheckIcon class="mt-0.5 size-5 shrink-0" />
					{:else}
						<InfoIcon class="mt-0.5 size-5 shrink-0" />
					{/if}
					<div class="min-w-0 space-y-1">
						<p class="text-sm font-medium">{legal.text}</p>
						<div class="text-base font-medium">Je Arbeitstag gerechnet: {strict.verdict.headline}</div>
						<p class="text-sm">{strict.verdict.detail}</p>
					</div>
				</div>
			</div>

			<!-- Erst die Zahl, an der das Gesetz misst, dann die strengere je
			     Arbeitstag. Rot nur, wo das Urteil rot ist. -->
			<div class="grid grid-cols-2 gap-3 sm:grid-cols-3">
				<StatTile label="Gesetzlich (Mo–Sa)" hint="Grenze {fmtHoursClock(NORM_DAILY)} h" alarm={legal.over}>
					{fmtHoursClock(legalWindow.average)} h
				</StatTile>
				<StatTile label="Je Arbeitstag" hint="Grenze {fmtHoursClock(NORM_DAILY)} h" {alarm}>
					{fmtHoursClock(strictWindow.average)} h
				</StatTile>
				<StatTile label="Puffer" hint="bis {fmtHoursClock(NORM_DAILY)} h je Arbeitstag" {alarm}>
					{strictWindow.bufferHours >= 0 ? "+" : "−"}{fmtHoursClock(Math.abs(strictWindow.bufferHours))} h
				</StatTile>
				<StatTile label="Dein Tempo" hint="Schnitt der letzten {paceWeeks} Wochen">
					{fmtHoursClock(result.pace)} h
				</StatTile>
				{#if strictOver}
					<!-- Schon darüber: kein Umkehrpunkt mehr, sondern der Tag, an dem es
					     ohne weitere Stunden wieder passt. -->
					<StatTile label="Unter 8 h" hint="frühestens, ohne weitere Stunden" {alarm}>
						{strict.reliefDate ? shortDate(strict.reliefDate) : "—"}
					</StatTile>
				{:else}
					<StatTile
						label="Umkehrpunkt"
						hint={strict.tooLate
							? "auch ohne weitere Stunden über 8 h"
							: strict.easeOffDate
								? "letzter Tag zum Drehen"
								: "nicht nötig"}
						{alarm}
					>
						{strict.tooLate ? "verstrichen" : strict.easeOffDate ? shortDate(strict.easeOffDate) : "—"}
					</StatTile>
				{/if}
				<StatTile label="Dauerhaft höchstens" {alarm}>
					{strict.maxPace === null || strict.maxPace <= 0 ? "—" : `${fmtHoursClock(strict.maxPace)} h`}
					{#snippet hintSlot()}
						<div class="text-muted-foreground text-xs">{maxPaceHint}</div>
					{/snippet}
				</StatTile>
			</div>

			{#if month > app.currentMonth}
				<p class="text-muted-foreground text-xs">
					{monthLabel(month)} liegt in der Zukunft – alle Zahlen beziehen sich auf heute.
				</p>
			{/if}
		</div>

		<!-- Verlauf -->
		<div class="space-y-2">
			<div class="flex flex-wrap items-center justify-between gap-3">
				<div class="flex flex-wrap items-baseline gap-x-2">
					<h3 class="text-sm font-medium">Die letzten 24 Wochen – und die Prognose ab {untilLabel}</h3>
					{#if !strictWindow.complete}
						<span class="text-muted-foreground text-xs">
							Datenbasis: {strictWindow.weeksCovered} von 24 Wochen – vorläufig.
						</span>
					{/if}
				</div>
				<!-- Der Schalter steuert die Prognose und gehört deshalb hierher,
				     nicht neben das Urteil. -->
				<div class="flex items-center gap-1 text-xs">
					<span class="text-muted-foreground mr-1">Prognose aus den letzten</span>
					{#each [4, 8, 12, 16] as w (w)}
						<Button
							variant={paceWeeks === w ? "secondary" : "ghost"}
							size="sm"
							class="h-6 px-2 text-xs"
							onclick={() => (paceWeeks = w)}
						>
							{w} Wo.
						</Button>
					{/each}
				</div>
			</div>
			<Chart.Container config={chartConfig} class="aspect-auto w-full" style="height: 260px">
				<!-- Ohne einen einzigen Eintrag bleibt die Fläche leer: ein Balken aus
				     null Stunden sähe sonst wie eine dramatische Woche aus. -->
				{#if forecastRows.length > 0 && strictWindow.actualHours > 0}
					<LineChart
						data={chartData}
						x="ts"
						xScale={scaleTime()}
						{xDomain}
						{yDomain}
						series={[
							{ key: "week", label: "Je Arbeitstag", color: "var(--color-week)" },
							{
								key: "average",
								label: "24-Wochen-Schnitt",
								color: "var(--color-average)",
								// SVG-Schreibweise, nicht camelCase: Spline reicht die Props
								// unverändert an das <path> durch.
								props: { "stroke-dasharray": "4 4" }
							},
							{
								key: "limit",
								label: "Grenze",
								color: "var(--color-limit)",
								props: { "stroke-dasharray": "2 3", "stroke-width": 1 }
							}
						]}
						annotations={[
							{ type: "range", layer: "below", x: [untilTs, null], class: "fill-muted-foreground/8" },
							{
								type: "line",
								x: untilTs,
								label: isToday ? "Heute" : shortDate(until),
								labelPlacement: "top-right",
								props: {
									line: { class: "stroke-muted-foreground" },
									label: { class: "fill-muted-foreground text-[10px]" }
								}
							}
						]}
						props={{
							xAxis: { ticks: monthTicks, format: tickLabel, tickLabelProps: { class: "fill-muted-foreground" } },
							yAxis: {
								format: (v: number) => fmtHoursClock(v),
								tickLabelProps: { class: "fill-muted-foreground" }
							}
						}}
					>
						{#snippet marks()}
							<Rect
								data={barsOver}
								x0="x0"
								x1="x1"
								y0={() => NORM_DAILY}
								y1="week"
								insets={{ x: 1 }}
								class="fill-amber-500/65 dark:fill-amber-400/55"
							/>
							<Rect
								data={barsUnder}
								x0="x0"
								x1="x1"
								y0={() => NORM_DAILY}
								y1="week"
								insets={{ x: 1 }}
								class="fill-muted-foreground/35"
							/>
							<Spline seriesKey="limit" />
							<Spline seriesKey="average" data={forecastRows} />
						{/snippet}
						{#snippet tooltip()}
							<Chart.Tooltip labelFormatter={tooltipLabel} formatter={tooltipRow} />
						{/snippet}
					</LineChart>
				{/if}
			</Chart.Container>
			<p class="text-muted-foreground text-xs">
				Jeder Balken steht für sieben Tage bis zum {weekdayLabel}: so viel hast du in dieser Zeit je
				Arbeitstag gearbeitet – nach oben mehr als 8 h, nach unten weniger. Freie Tage zum
				Zeitausgleich zählen dabei nicht als Arbeitstag. Ab {untilLabel} zeigt die gestrichelte
				Linie, wohin der 24-Wochen-Schnitt läuft, wenn du mit {fmtHoursClock(result.pace)} h je
				Arbeitstag weitermachst – dem Durchschnitt der letzten {paceWeeks} Wochen.
				<!-- Der Anstieg ist Fensterrechnung, kein Trend – das sagt die Linie nicht von selbst. -->
				{#if result.pace > strictWindow.average + 0.01}
					Sie steigt, weil die kurzen Balken links nach und nach aus den 24 Wochen herausfallen und
					Tage mit {fmtHoursClock(result.pace)} h nachrücken – bleibt es dabei, endet der Schnitt bei
					{fmtHoursClock(result.pace)} h.
				{:else if result.pace < strictWindow.average - 0.01}
					Sie fällt, weil die langen Balken links nach und nach aus den 24 Wochen herausfallen.
				{/if}
			</p>
		</div>

		<!-- Tagesbefunde -->
		<div class="space-y-2">
			<h3 class="text-sm font-medium">Auffällige Tage</h3>
			{#if byDay.length === 0}
				<p class="text-muted-foreground flex items-center gap-2 text-sm">
					<CheckIcon class="size-4" /> Keine Auffälligkeiten in diesem Monat.
				</p>
			{:else}
				<p class="text-muted-foreground text-xs">
					{result.counts.violation}
					{result.counts.violation === 1 ? "Verstoß" : "Verstöße"} · {result.counts.risk} knapp ·
					{result.counts.hint}
					{result.counts.hint === 1 ? "Hinweis" : "Hinweise"}
				</p>
				<!-- Ohne diesen Satz ist am Handy nichts zu sehen, was die Badges als
				     anklickbar ausweist - Hover gibt es dort nicht. -->
				<p class="text-muted-foreground text-xs">
					Jeder Befund lässt sich anklicken – dahinter steht, worauf er sich stützt.
				</p>
				<table class="w-full text-sm">
					<tbody>
						{#each byDay as d (d.date)}
							<!-- Die Zeile führt in die Einträge des Tages. Der Klick hängt am
							     Datum und nicht an der ganzen Zeile: rechts stehen die Badges mit
							     eigener Erklärung, und ein Knopf im Knopf wäre weder gültiges
							     HTML noch mit der Tastatur zu bedienen. Der Hover färbt
							     trotzdem die ganze Zeile, damit sie als anklickbar zu erkennen ist. -->
							<tr class="hover:bg-muted/50 border-b last:border-0">
								<td class="py-1 align-top">
									<button
										class="group inline-flex cursor-pointer items-center gap-1 hover:underline"
										title="Einträge dieses Tages anzeigen"
										onclick={() => openDay(d.date)}
									>
										{fmtDateHuman(noonTs(d.date))}
										<ChevronRightIcon
											class="size-3.5 opacity-0 transition-opacity group-hover:opacity-60"
										/>
									</button>
								</td>
								<td class="py-1">
									<div class="flex flex-wrap justify-end gap-1">
										{#each d.findings as f (f.rule)}
											<!--
												Popover statt Tooltip: die Erklärung hängt sonst am Hover
												und ist auf dem Handy gar nicht zu bekommen - dort ist sie
												aber genauso nötig. Ein Klick öffnet, Escape schliesst,
												und die Tastatur kommt genauso hin.
											-->
											<Popover.Root>
												<Popover.Trigger
													class="focus-visible:ring-ring/50 cursor-pointer rounded-4xl outline-none transition-opacity hover:opacity-80 focus-visible:ring-3"
													aria-label="{f.label} – erklären"
												>
													<Badge variant={badgeVariant(f.level)}>
														{#if f.level === "violation"}
															<TriangleAlertIcon />
														{:else if f.level === "hint"}
															<InfoIcon />
														{/if}
														{f.label}
													</Badge>
												</Popover.Trigger>
												<Popover.Content align="end" class="space-y-1.5">
													<div class="flex items-center gap-1.5">
														<Badge variant={badgeVariant(f.level)}>{f.label}</Badge>
														<span class="text-muted-foreground text-xs">
															{fmtDateHuman(noonTs(d.date))}
														</span>
													</div>
													<p class="text-muted-foreground text-xs leading-relaxed">{f.text}</p>
												</Popover.Content>
											</Popover.Root>
										{/each}
									</div>
								</td>
							</tr>
						{/each}
					</tbody>
				</table>
			{/if}
		</div>

		{/if}

		<!-- Was diese Card nicht abdeckt. -->
		<p class="text-muted-foreground border-t pt-3 text-xs">
			Erfasst werden Projektzeiten, keine Stempelzeiten – das hier ist eine Annahme, kein Nachweis,
			und kein Rechtsrat. Maßgeblich bleibt die Zeiterfassung deines Arbeitgebers.
			{#if app.settings.breakDeduction}
				Pausen werden wie in LOGA automatisch abgezogen und deshalb nicht gesondert geprüft.
			{:else}
				Der automatische Pausenabzug ist aus: Pausen werden aus den Lücken zwischen den Einträgen
				bewertet (§ 4).
			{/if}
			Die Rechnung bezogen auf deine Arbeitstage zählt nur diese als Werktage – das ist keine Gesetzeslage,
			sondern der Frühwarnwert.
		</p>
	</Card.Content>
</Card.Root>

