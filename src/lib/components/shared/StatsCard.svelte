<script lang="ts">
	import { app } from "$lib/app.svelte";
	import type { MonthReport } from "$lib/report";
	import { dayActivityHours, heatmapYear, sumPerDay, targetHours } from "$lib/stats";
	import { fmtDateHuman, fmtHoursClock, MINUTE_MS, monthLabel, noonTs, quantize } from "$lib/time";
	import { zonedParts } from "$lib/tz";
	import type { Entry } from "$lib/types";
	import * as Card from "$lib/components/ui/card";
	import * as Chart from "$lib/components/ui/chart";
	import { Skeleton } from "$lib/components/ui/skeleton";
	import StatTile from "$lib/components/shared/StatTile.svelte";
	import { BarChart } from "layerchart";
	import { scaleBand } from "d3-scale";

	interface Props {
		/** ausgewaehlter Monat "YYYY-MM" */
		month: string;
		/** Bericht des Monats – liefert die bereits gerundeten Stunden je Aktivitaet */
		report: MonthReport;
	}
	let { month, report }: Props = $props();

	const year = $derived(Number(month.slice(0, 4)));
	const monthKeys = $derived(
		Array.from({ length: 12 }, (_, i) => `${year}-${String(i + 1).padStart(2, "0")}`)
	);

	// Die Heatmap braucht das ganze Jahr, der Monatswechsel laedt aber nur einen Monat.
	$effect(() => {
		for (const m of monthKeys) void app.ensureMonth(m);
	});

	const absenceIds = $derived(
		new Set(app.activities.filter((a) => a.isAbsence).map((a) => a.id))
	);
	const yearEntries = $derived(monthKeys.flatMap((m) => app.monthEntries(m) as Entry[]));

	/** Ist das ganze Jahr geladen? */
	const yearReady = $derived(monthKeys.every((m) => app.monthLoaded(m)));

	// `app.now` tickt im Sekundentakt. Nur ein laufender Timer IN DIESEM JAHR braucht
	// ihn (seine Dauer waechst); sonst liefe die komplette Jahresauswertung – zwei
	// Maps, das Wochenraster und ~370 keyed Spans – jede Sekunde neu. Abgeschlossene
	// Eintraege haben ein endTs und lesen `now` gar nicht, der Wert ist dann egal.
	const runningInYear = $derived(
		app.running !== null && zonedParts(app.running.startTs).year === year
	);
	// Auf fuenf Minuten gerundet: `app.now` tickt im Sekundentakt, ein Jahresraster
	// aendert sich dadurch aber nicht sichtbar – eine Zelle deckt einen ganzen Tag
	// ab, ihre Faerbung haengt an Quartilen des Jahresmaximums. Ohne die Rundung
	// laufen Aufschluesselung, Summen, Raster und ~370 keyed Spans jede Sekunde
	// neu, nur weil irgendwo ein Timer laeuft.
	const statsNow = $derived(runningInYear ? quantize(app.now, 5 * MINUTE_MS) : 0);

	// Einmal aufschluesseln, Summen daraus ableiten – nicht zweimal ueber alles laufen.
	const detailByDay = $derived(dayActivityHours(yearEntries, absenceIds, statsNow, app.settings.breakDeduction));
	const byDay = $derived(sumPerDay(detailByDay));
	const weeks = $derived(heatmapYear(year, byDay));

	// EIN Tooltip-Element fuer alle Zellen: ein Jahr hat ~365 davon, eine
	// Floating-Instanz je Zelle waere reine Verschwendung. Gemerkt wird nur das
	// Datum – ein festgehaltener Tag waere eine Kopie und veraltete, sobald ein
	// Timer an diesem Tag weiterlaeuft.
	let hover = $state<{ date: string; x: number; y: number } | null>(null);
	const hoverHours = $derived(hover ? (byDay.get(hover.date) ?? 0) : 0);
	let tipW = $state(0);
	let tipH = $state(0);

	/**
	 * Position des Tooltips. Kippt an den Zeiger-Gegenseite, wenn unten oder rechts
	 * kein Platz mehr ist – die Heatmap steht am Seitenende, dort waere er sonst
	 * abgeschnitten. Braucht die gemessene Groesse, deshalb kein reines CSS.
	 */
	const tipPos = $derived.by(() => {
		if (!hover) return { left: 0, top: 0 };
		const gap = 14;
		const edge = 8;
		let left = hover.x + gap;
		let top = hover.y + gap;
		if (left + tipW > window.innerWidth - edge) left = hover.x - gap - tipW;
		if (top + tipH > window.innerHeight - edge) top = hover.y - gap - tipH;
		return { left: Math.max(edge, left), top: Math.max(edge, top) };
	});

	/** Projekte eines Tages, absteigend nach Stunden. */
	const hoverRows = $derived.by(() => {
		if (!hover) return [];
		const perActivity = detailByDay.get(hover.date);
		if (!perActivity) return [];
		return [...perActivity.entries()]
			.map(([id, hours]) => ({ name: app.activityName(id), hours }))
			.sort((a, b) => b.hours - a.hours);
	});

	const dateLabel = (iso: string) => fmtDateHuman(noonTs(iso));

	// ---- Saldo ----
	// Ist = Arbeitszeit + Abwesenheiten: ein Urlaubstag ist erfuellte Zeit, kein Minus.
	// Der Zeitausgleich zaehlt dabei mit, wie jede andere Abwesenheit.
	const target = $derived(targetHours(month, app.settings.workdays, app.settings.hoursPerDay, app.now));
	const balance = $derived(report.total - target);

	// ---- Balken: Stunden je Aktivitaet ----
	// Nur Projektzeiten, absteigend – die Laenge traegt die Aussage, nicht die Farbe.
	const bars = $derived(
		report.rows
			.filter((r) => !r.isAbsence && r.hours > 0)
			.map((r) => ({ name: r.name, hours: r.hours }))
			.sort((a, b) => b.hours - a.hours)
	);
	const workTotal = $derived(bars.reduce((s, b) => s + b.hours, 0));

	// Eine Hue: der Job ist Groessenvergleich, nicht Identitaet – die Namen an der
	// Achse tragen die Identitaet, deshalb waeren acht Farben hier verschenkt.
	const chartConfig = {
		hours: { label: "Stunden", theme: { light: "#2a78d6", dark: "#3987e5" } }
	} satisfies Chart.ChartConfig;

	const heatLabel = (h: number) =>
		h > 0 ? `${fmtHoursClock(h)} h` : "keine erfasste Zeit";
	const WEEKDAYS = ["Mo", "", "Mi", "", "Fr", "", ""];

	/**
	 * Monatswechsel als Spaltenindex – fuer die Beschriftung ueber dem Raster.
	 * Der Monatserste kann auf JEDEN Wochentag fallen, nicht nur auf den ersten
	 * Tag der Spalte – sonst fehlen alle Monate, die mitten in der Woche beginnen.
	 */
	/** Gemessene Breite des Diagramms – entscheidet ueber die Beschriftungsspalte. */
	let chartWidth = $state(0);

	/**
	 * Platz fuer die Aktivitaetsnamen links. Auf einer schmalen Karte kostet die
	 * feste Spalte ein Drittel der Flaeche – dann lieber kuerzere Namen als
	 * Balken, an denen nichts mehr abzulesen ist. 0 = noch nicht gemessen.
	 */
	const axisPad = $derived(chartWidth > 0 && chartWidth < 420 ? 72 : 104);

	const monthTicks = $derived(
		weeks
			.map((w, i) => {
				const firstOfMonth = w.find((d) => !d.filler && d.date.endsWith("-01"));
				return firstOfMonth
					? { i, label: monthLabel(firstOfMonth.date.slice(0, 7)).slice(0, 3) }
					: null;
			})
			.filter((t): t is { i: number; label: string } => t !== null)
	);
</script>

<Card.Root>
	<Card.Header>
		<Card.Title>Auswertung</Card.Title>
		<Card.Description>Saldo, Verteilung und gearbeitete Tage – nur für dich, nicht Teil der E-Mail.</Card.Description>
	</Card.Header>
	<Card.Content class="space-y-8">
		<!-- Saldo: Kennzahlen, kein Diagramm. Zwei Spalten schon ab 360px – die
		     Kacheln tragen ihre Beschriftung selbst und brauchen keine ganze Zeile. -->
		<div class="space-y-2">
			<div class="grid grid-cols-2 gap-3 sm:grid-cols-3">
				<StatTile label="Ist">{fmtHoursClock(report.total)} h</StatTile>
				<StatTile label="Soll" hint={month === app.currentMonth ? "Werktage bis heute" : undefined}>
					{fmtHoursClock(target)} h
				</StatTile>
				<StatTile
					label="Saldo"
					class="col-span-2 sm:col-span-1"
					valueClass={Math.abs(balance) < 0.01 ? "text-muted-foreground" : undefined}
				>
					{balance >= 0 ? "+" : "−"}{fmtHoursClock(Math.abs(balance))} h
				</StatTile>
			</div>
			{#if report.timeOffHours > 0}
				<p class="text-muted-foreground text-xs">
					Davon {fmtHoursClock(report.timeOffHours)} h Zeitausgleich.
				</p>
			{/if}
			{#if month === app.currentMonth}
				<p class="text-muted-foreground text-xs">
					Laufender Monat: Soll zählt nur die Werktage bis heute.
				</p>
			{/if}
		</div>

		<!-- Stunden je Aktivitaet -->
		<div class="space-y-2">
			<h3 class="text-sm font-medium">Stunden je Aktivität</h3>
			{#if bars.length === 0}
				<p class="text-muted-foreground text-sm">Keine Projektzeiten in {monthLabel(month)}.</p>
			{:else}
				<!-- Feste Zeilenhoehe statt Seitenverhaeltnis: sonst werden die Balken bei
				     wenigen Aktivitaeten fett. Als Style, weil Tailwind dynamische
				     Arbitrary-Values nicht kompilieren kann. -->
				<div bind:clientWidth={chartWidth}>
				<Chart.Container
					config={chartConfig}
					class="aspect-auto w-full"
					style="height: {bars.length * 30 + 8}px"
				>
					<BarChart
						data={bars}
						orientation="horizontal"
						y="name"
						yScale={scaleBand()}
						bandPadding={0.45}
						x="hours"
						axis="y"
						grid={false}
						padding={{ left: axisPad, right: 8 }}
						series={[{ key: "hours", label: "Stunden", color: "var(--color-hours)" }]}
						props={{ bars: { radius: 4, rounded: "right" }, yAxis: { tickLabelProps: { class: "fill-muted-foreground" } } }}
					>
						{#snippet tooltip()}
							<Chart.Tooltip />
						{/snippet}
					</BarChart>
				</Chart.Container>
				</div>
				<!-- Tabelle als zweiter Kanal: exakte Werte, unabhaengig von der Farbe. -->
				<table class="w-full text-sm">
					<tbody>
						{#each bars as b (b.name)}
							<tr class="border-b last:border-0">
								<td class="py-1">{b.name}</td>
								<td class="py-1 text-right tabular-nums">{fmtHoursClock(b.hours)} h</td>
								<td class="text-muted-foreground w-12 py-1 text-right tabular-nums">
									{workTotal > 0 ? Math.round((b.hours / workTotal) * 100) : 0}%
								</td>
							</tr>
						{/each}
					</tbody>
				</table>
			{/if}
		</div>

		<!-- Jahres-Heatmap: gearbeitete Stunden je Tag -->
		<div class="space-y-2">
			<h3 class="text-sm font-medium">Gearbeitet {year}</h3>
			{#if !yearReady}
				<!-- Platzhalter im Zuschnitt des Wochenrasters: sonst fuellt sich die
				     Heatmap sichtbar von hinten nach vorn, waehrend die Monate
				     nachladen. -->
				<div class="space-y-1" style="margin-left:1.75rem;">
					<Skeleton class="h-3 w-full max-w-160" />
					<Skeleton class="h-22 w-full max-w-160" />
				</div>
			{:else}
			<div class="overflow-x-auto pb-1">
				<div class="w-max">
					<!-- Eine Wochenspalte ist 11px breit + 3px Abstand = 14px Raster. -->
					<div class="text-muted-foreground relative mb-1 h-3 text-[10px]" style="margin-left:1.75rem;">
						{#each monthTicks as t (t.i)}
							<span class="absolute top-0" style="left:{t.i * 14}px">{t.label}</span>
						{/each}
					</div>
					<div class="flex gap-0.75">
						<div class="text-muted-foreground mr-1 flex flex-col gap-0.75 text-[10px]">
							{#each WEEKDAYS as d, i (i)}
								<span class="h-2.75 w-6 leading-2.75">{d}</span>
							{/each}
						</div>
						{#each weeks as week, wi (wi)}
							<div class="flex flex-col gap-0.75">
								{#each week as day (day.date)}
									{#if day.filler}
										<span class="size-2.75"></span>
									{:else}
										<span
											class="heat size-2.75 rounded-[2px]"
											data-level={day.level}
											role="img"
											aria-label="{dateLabel(day.date)}: {heatLabel(day.hours)}"
											onmouseenter={(e) => (hover = { date: day.date, x: e.clientX, y: e.clientY })}
											onmousemove={(e) => (hover = { date: day.date, x: e.clientX, y: e.clientY })}
											onmouseleave={() => (hover = null)}
										></span>
									{/if}
								{/each}
							</div>
						{/each}
					</div>
					<div class="text-muted-foreground mt-2 flex items-center gap-1 text-[10px]">
						<span>weniger</span>
						{#each [0, 1, 2, 3, 4] as l (l)}
							<span class="heat size-2.75 rounded-[2px]" data-level={l}></span>
						{/each}
						<span>mehr</span>
					</div>
				</div>
			</div>
			{/if}
		</div>
	</Card.Content>
</Card.Root>

{#if hover}
	<!-- Folgt dem Zeiger; kippt an Viewport-Raendern (siehe tipPos). -->
	<div
		bind:clientWidth={tipW}
		bind:clientHeight={tipH}
		class="bg-popover text-popover-foreground pointer-events-none fixed z-50 rounded-md border px-2.5 py-1.5 text-xs shadow-md"
		style="left:{tipPos.left}px; top:{tipPos.top}px"
	>
		<div class="font-medium">{dateLabel(hover.date)}</div>
		<div class="text-muted-foreground">{heatLabel(hoverHours)}</div>
		{#if hoverRows.length > 0}
			<div class="mt-1 space-y-0.5 border-t pt-1">
				{#each hoverRows as r (r.name)}
					<div class="flex justify-between gap-3">
						<span>{r.name}</span>
						<span class="tabular-nums">{fmtHoursClock(r.hours)} h</span>
					</div>
				{/each}
			</div>
		{/if}
	</div>
{/if}

<style>
	/* Sequenzielle Rampe (eine Hue, hell->dunkel) – in BEIDEN Themes in dieselbe
	   Richtung: hell = wenig, dunkel = viel, sonst kippt die Bedeutung mit dem
	   Theme. Im Dunkelmodus endet die Rampe deshalb bei einem mittleren Blau
	   statt im Schwarz – dunkel genug fuer die Aussage, hell genug gegen die
	   Card (#171717). Level 0 (nichts erfasst) bleibt neutral grau. */
	.heat {
		background: var(--heat-0);
	}
	.heat[data-level="1"] { background: var(--heat-1); }
	.heat[data-level="2"] { background: var(--heat-2); }
	.heat[data-level="3"] { background: var(--heat-3); }
	.heat[data-level="4"] { background: var(--heat-4); }

	:global(:root) {
		--heat-0: #f5f5f5;
		--heat-1: #86b6ef;
		--heat-2: #3987e5;
		--heat-3: #256abf;
		--heat-4: #104281;
	}
	:global(.dark) {
		--heat-0: #262626;
		--heat-1: #b8d4f6;
		--heat-2: #6ea6ec;
		--heat-3: #3d7fcf;
		--heat-4: #1e5296;
	}
</style>
