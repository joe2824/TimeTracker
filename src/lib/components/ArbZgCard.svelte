<script lang="ts">
	import { app } from "$lib/app.svelte";
	import {
		arbzgMonths,
		checkArbZg,
		dataFromEntries,
		DEFAULT_PACE_WEEKS,
		NORM_DAILY,
		type ArbZgFinding,
		type ArbZgLevel,
		type Forecast
	} from "$lib/arbzg";
	import { entriesFocus } from "$lib/entriesFocus.svelte";
	import { fmtDate, fmtDateHuman, fmtHoursClock, monthLabel, noonTs } from "$lib/time";
	import type { Entry } from "$lib/types";
	import { Badge } from "$lib/components/ui/badge";
	import { Button } from "$lib/components/ui/button";
	import * as Card from "$lib/components/ui/card";
	import * as Chart from "$lib/components/ui/chart";
	import * as Tooltip from "$lib/components/ui/tooltip";
	import { LineChart } from "layerchart";
	import { scaleTime } from "d3-scale";
	import TriangleAlertIcon from "@lucide/svelte/icons/triangle-alert";
	import InfoIcon from "@lucide/svelte/icons/info";
	import CheckIcon from "@lucide/svelte/icons/check";

	interface Props {
		/** ausgewaehlter Monat "YYYY-MM" */
		month: string;
	}
	let { month }: Props = $props();

	/** Referenzzeitraum fuer das angenommene Tempo (siehe DEFAULT_PACE_WEEKS). */
	let paceWeeks = $state(DEFAULT_PACE_WEEKS);

	/**
	 * Stichtag: das Monatsende – aber nie in der Zukunft.
	 *
	 * Die Monatsauswahl kennt keine obere Grenze. Ohne die Deckelung liegen bei
	 * einem kuenftigen Monat alle Tage von heute bis dahin als Werktage mit null
	 * Stunden im Fenster; aus zehn Stunden am Tag wird dann ein Schnitt von 6:20
	 * und aus "Grenze bereits gerissen" ein "im gruenen Bereich". Je weiter man
	 * nach vorn blaettert, desto beruhigender die Auskunft – genau verkehrt herum.
	 */
	const until = $derived.by(() => {
		const today = fmtDate(Date.now());
		const [y, m] = month.split("-").map(Number);
		const monthEnd = fmtDate(new Date(y, m, 0).getTime());
		return monthEnd > today ? today : monthEnd;
	});

	const monthsNeeded = $derived(arbzgMonths(until));

	$effect(() => {
		for (const m of monthsNeeded) void app.ensureMonth(m);
	});

	const absenceIds = $derived(new Set(app.activities.filter((a) => a.isAbsence).map((a) => a.id)));
	const entries = $derived(monthsNeeded.flatMap((m) => app.monthEntries(m) as Entry[]));

	const dataFrom = $derived(dataFromEntries(entries, until));

	// Wie in StatsCard: `app.now` tickt im Sekundentakt und wuerde die ganze
	// Rechnung samt Kurve jede Sekunde neu aufbauen. Nur ein laufender Timer
	// braucht ihn; sonst haben alle Eintraege ein Ende und lesen `now` gar nicht.
	const runningToday = $derived(app.running !== null && fmtDate(app.running.startTs) === until);
	const checkNow = $derived(runningToday ? app.now : noonTs(until));

	const result = $derived(
		checkArbZg(entries, {
			until,
			dataFrom,
			workdays: app.settings.workdays,
			deductBreaks: app.settings.breakDeduction,
			absenceIds,
			now: checkNow,
			paceWeeks
		})
	);

	const strict = $derived(result.forecasts.strict);
	const legal = $derived(result.forecasts.legal);
	const strictWindow = $derived(result.windows.strict);

	// Rot bedeutet ueberall dasselbe: handeln. Ein Schnitt knapp ueber acht
	// Stunden ist noch kein Notfall – solange der Umkehrpunkt in der Ferne liegt,
	// laesst er sich durch Kuerzertreten einholen, und dann darf die Zahl auch
	// nicht rot leuchten.
	const alarm = $derived(strict.verdict.requiresAction);

	// ---- Kurve ----
	// Nur die STRENGE Linie ins Diagramm. Die gesetzliche liegt bei einer
	// Fuenf-Tage-Woche rund zwei Stunden tiefer; zusammen in einem Achsenbereich
	// wird aus dem Anlaufen an die Grenze ein flacher Strich, und genau das ist
	// die Bewegung, um die es geht. Ihre Aussage steht als Zeile darueber.
	const chartData = $derived(
		strict.points.map((p) => ({
			ts: new Date(noonTs(p.date)),
			schnitt: p.average,
			grenze: NORM_DAILY
		}))
	);

	// Ohne feste Domain nimmt das Diagramm die Null mit auf – die halbe Hoehe
	// waere dann leer und die entscheidenden Zehntel um die 8 h unsichtbar.
	const yDomain = $derived.by(() => {
		const values = [NORM_DAILY, ...strict.points.map((p) => p.average)];
		return [Math.min(...values) - 0.25, Math.max(...values) + 0.25];
	});

	/**
	 * Monatserste als Achsenmarken.
	 *
	 * Weder automatisch noch als Anzahl: bei einer Marke je Datenpunkt stand
	 * derselbe Monat fuenfmal nebeneinander, bei einer gedeckelten Anzahl blieben
	 * zwei Beschriftungen fuer ein halbes Jahr uebrig. Ein Monatsraster ist das,
	 * was hier gelesen wird.
	 */
	const monthTicks = $derived.by(() => {
		const out: Date[] = [];
		if (chartData.length === 0) return out;
		const first = chartData[0].ts;
		const last = chartData[chartData.length - 1].ts;
		const cursor = new Date(first.getFullYear(), first.getMonth(), 1);
		if (cursor < first) cursor.setMonth(cursor.getMonth() + 1);
		while (cursor <= last) {
			out.push(new Date(cursor));
			cursor.setMonth(cursor.getMonth() + 1);
		}
		return out;
	});

	// Das Jahr nur im Januar – sonst steht es sechsmal da, wo es niemand braucht.
	const tickLabel = (d: Date) =>
		d.toLocaleDateString("de-DE", d.getMonth() === 0 ? { month: "short", year: "2-digit" } : { month: "short" });

	const chartConfig = {
		schnitt: { label: "Schnitt", theme: { light: "#2a78d6", dark: "#6ea6ec" } },
		grenze: { label: "Grenze", theme: { light: "#dc2626", dark: "#f87171" } }
	} satisfies Chart.ChartConfig;

	// ---- Befunde ----
	const LEVEL_ORDER: Record<ArbZgLevel, number> = { verstoss: 0, risiko: 1, hinweis: 2 };
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
		level === "verstoss" ? ("destructive" as const) : ("outline" as const);

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
		<!-- Das Urteil zuerst: die Frage lautet "muss ich etwas tun?", und die
		     muss vor jeder Zahl beantwortet sein. -->
		<div class="space-y-3">
			<div class="flex flex-wrap items-start justify-between gap-3">
				<!-- Farbe bedeutet Handlungsbedarf, sonst nichts. „Dicht an der Grenze"
				     ist eine Beobachtung, keine Aufforderung – die stand vorher gelb
				     da und liess niemanden wissen, was zu tun sei. -->
				<div
					class="flex flex-1 items-start gap-3 rounded-md border px-4 py-3"
					class:verdict-crit={strict.verdict.requiresAction && strict.verdict.level === "crit"}
					class:verdict-warn={strict.verdict.requiresAction && strict.verdict.level !== "crit"}
				>
					{#if strict.verdict.requiresAction}
						<TriangleAlertIcon class="mt-0.5 size-5 shrink-0" />
					{:else if strict.verdict.level === "ok"}
						<CheckIcon class="mt-0.5 size-5 shrink-0" />
					{:else}
						<InfoIcon class="mt-0.5 size-5 shrink-0" />
					{/if}
					<div class="min-w-0 space-y-1">
						<div class="flex flex-wrap items-baseline gap-x-2">
							<span class="text-base font-medium">{strict.verdict.headline}</span>
							<span class="text-muted-foreground text-xs">streng gerechnet</span>
						</div>
						<p class="text-sm">{strict.verdict.detail}</p>
					</div>
				</div>
			</div>

			<div class="flex flex-wrap gap-8">
				<div>
					<div class="text-muted-foreground text-xs">Schnitt · 24 Wochen</div>
					<div class="text-2xl" class:text-destructive={alarm}>
						{fmtHoursClock(strictWindow.average)} h
					</div>
					<div class="text-muted-foreground text-xs">Grenze {fmtHoursClock(NORM_DAILY)} h</div>
				</div>
				<div>
					<div class="text-muted-foreground text-xs">Puffer</div>
					<div class="text-2xl" class:text-destructive={alarm}>
						{strictWindow.bufferHours >= 0 ? "+" : "−"}{fmtHoursClock(Math.abs(strictWindow.bufferHours))} h
					</div>
					<div class="text-muted-foreground text-xs">im Fenster</div>
				</div>
				<div>
					<div class="text-muted-foreground text-xs">Dein Tempo</div>
					<div class="text-2xl">{fmtHoursClock(result.pace)} h</div>
					<div class="text-muted-foreground text-xs">je Arbeitstag</div>
				</div>
				<div>
					<div class="text-muted-foreground text-xs">Umkehrpunkt</div>
					<div class="text-2xl" class:text-destructive={alarm}>
						{#if strict.tooLate}
							verstrichen
						{:else if strict.easeOffDate}
							{new Date(noonTs(strict.easeOffDate)).toLocaleDateString("de-DE", {
								day: "2-digit",
								month: "2-digit"
							})}
						{:else}
							—
						{/if}
					</div>
					<div class="text-muted-foreground text-xs">
						{strict.easeOffDate || strict.tooLate ? "letzter Tag zum Drehen" : "nicht nötig"}
					</div>
				</div>
				<div>
					<div class="text-muted-foreground text-xs">Höchstens</div>
					<div class="text-2xl">
						{strict.maxPace === null || strict.maxPace <= 0
							? "—"
							: `${fmtHoursClock(strict.maxPace)} h`}
					</div>
					{#if strict.paceDelta !== null && strict.paceDelta < 0}
						<div class="text-destructive text-xs">
							{fmtHoursClock(strict.paceDelta)} h je Tag
						</div>
					{:else}
						<div class="text-muted-foreground text-xs">je Arbeitstag</div>
					{/if}
				</div>
			</div>

			{#if month > app.currentMonth}
				<p class="text-muted-foreground text-xs">
					{monthLabel(month)} liegt in der Zukunft – Urteil und Prognose beziehen sich auf heute.
				</p>
			{/if}

			<!-- Die gesetzliche Lesart und die Datenlage: beides gehoert gesagt,
			     beides ist Nebensache. Eine Zeile, nicht zwei Absaetze. -->
			<!-- Nebeneinander gelesen wirkte das wie ein Widerspruch: oben eine
			     Warnung, darunter „unkritisch". Wo gewarnt wird, sagt die Zeile
			     deshalb zuerst, worauf sich die Warnung stuetzt. -->
			<p class="text-muted-foreground text-xs">
				{#if strict.verdict.requiresAction && legal.verdict.level === "ok"}
					Warum trotzdem eine Warnung: nach dem Gesetz (Werktage Mo–Sa) läge der Schnitt bei
					{fmtHoursClock(result.windows.legal.average)} h und wäre unkritisch. Gewarnt wird nach der
					strengen Rechnung, die nur deine Arbeitstage als Werktage zählt – nur die warnt früh
					genug, um noch etwas ändern zu können.
				{:else}
					Gesetzlich (Mo–Sa): {fmtHoursClock(result.windows.legal.average)} h Schnitt, Puffer {fmtHoursClock(
						result.windows.legal.bufferHours
					)} h – {legal.verdict.level === "ok" ? "unkritisch" : legal.verdict.headline.toLowerCase()}.
				{/if}
				{#if !strictWindow.complete}
					· Datenbasis erst {strictWindow.weeksCovered} von 24 Wochen, daher vorläufig.
				{/if}
			</p>
		</div>

		<!-- Verlauf -->
		<div class="space-y-2">
			<div class="flex flex-wrap items-center justify-between gap-3">
				<h3 class="text-sm font-medium">Verlauf des Schnitts</h3>
				<!-- Der Schalter steuert die Prognose und gehoert deshalb hierher,
				     nicht neben das Urteil. -->
				<div class="flex items-center gap-1 text-xs">
					<span class="text-muted-foreground mr-1">Prognose aus den letzten</span>
					{#each [4, 8, 12] as w (w)}
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
			<Chart.Container config={chartConfig} class="aspect-auto w-full" style="height: 220px">
				<LineChart
					data={chartData}
					x="ts"
					xScale={scaleTime()}
					{yDomain}
					series={[
						{ key: "schnitt", label: "Schnitt", color: "var(--color-schnitt)" },
						{
							key: "grenze",
							label: "Grenze",
							color: "var(--color-grenze)",
							// SVG-Schreibweise, nicht camelCase: Spline reicht die Props
							// unveraendert an das <path> durch.
							props: { "stroke-dasharray": "4 4" }
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
					{#snippet tooltip()}
						<Chart.Tooltip
							labelFormatter={(v) => fmtDateHuman(new Date(v as string | number | Date).getTime())}
							formatter={tooltipRow}
						/>
					{/snippet}
				</LineChart>
			</Chart.Container>
			<p class="text-muted-foreground text-xs">
				Ab heute fortgeschrieben mit {fmtHoursClock(result.pace)} h je Arbeitstag – dem Durchschnitt
				der letzten {paceWeeks} Wochen.
				<!-- Die Steigung ist die eigentliche Aussage der Kurve und erklaert
				     sich nicht von selbst: sie ist kein Trend, sondern das Fenster,
				     das sich mit Tagen des aktuellen Tempos fuellt. -->
				{#if result.pace > strictWindow.average + 0.01}
					Die Kurve steigt, weil das rollende Fenster Woche für Woche ältere, kürzere Tage gegen
					Tage dieses Tempos tauscht – bleibt es dabei, endet der Schnitt bei {fmtHoursClock(
						result.pace
					)} h.
				{:else if result.pace < strictWindow.average - 0.01}
					Die Kurve fällt, weil das rollende Fenster Woche für Woche ältere, längere Tage gegen
					Tage dieses Tempos tauscht.
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
					{result.counts.verstoss}
					{result.counts.verstoss === 1 ? "Verstoß" : "Verstöße"} · {result.counts.risiko} knapp ·
					{result.counts.hinweis}
					{result.counts.hinweis === 1 ? "Hinweis" : "Hinweise"}
				</p>
				<Tooltip.Provider>
				<table class="w-full text-sm">
					<tbody>
						{#each byDay as d (d.date)}
							<tr class="border-b last:border-0">
								<td class="py-1 align-top">
									<button class="hover:underline" onclick={() => openDay(d.date)}>
										{fmtDateHuman(noonTs(d.date))}
									</button>
								</td>
								<td class="py-1">
									<div class="flex flex-wrap justify-end gap-1">
										{#each d.findings as f (f.rule)}
											<Tooltip.Root>
												<Tooltip.Trigger>
													<Badge variant={badgeVariant(f.level)}>
														{#if f.level === "verstoss"}
															<TriangleAlertIcon />
														{:else if f.level === "hinweis"}
															<InfoIcon />
														{/if}
														{f.label}
													</Badge>
												</Tooltip.Trigger>
												<Tooltip.Content class="max-w-72">
													{f.text}
												</Tooltip.Content>
											</Tooltip.Root>
										{/each}
									</div>
								</td>
							</tr>
						{/each}
					</tbody>
				</table>
				</Tooltip.Provider>
			{/if}
		</div>

		<!-- Was diese Card nicht weiss. Gehoert hierher, nicht in die README. -->
		<p class="text-muted-foreground border-t pt-3 text-xs">
			Erfasst werden Projektzeiten, keine Stempelzeiten – das hier ist eine Annahme, kein Nachweis,
			und kein Rechtsrat. Maßgeblich bleibt die Zeiterfassung deines Arbeitgebers.
			{#if app.settings.breakDeduction}
				Pausen werden wie in LOGA automatisch abgezogen und deshalb nicht gesondert geprüft.
			{:else}
				Der automatische Pausenabzug ist aus: Pausen werden aus den Lücken zwischen den Einträgen
				bewertet (§ 4).
			{/if}
			Die strenge Lesart zählt nur deine Arbeitstage als Werktage – das ist keine Gesetzeslage,
			sondern der Frühwarnwert.
		</p>
	</Card.Content>
</Card.Root>

<style>
	/* Nur das Urteil traegt Farbe. Die Stufen sind bewusst zurueckhaltend
	   getoent: der Rahmen soll die Aussage stuetzen, nicht die Card uebertoenen. */
	.verdict-crit {
		border-color: color-mix(in oklab, var(--destructive) 50%, transparent);
		background: color-mix(in oklab, var(--destructive) 6%, transparent);
		color: var(--destructive);
	}
	.verdict-warn {
		border-color: color-mix(in oklab, #f59e0b 55%, transparent);
		background: color-mix(in oklab, #f59e0b 7%, transparent);
		color: #b45309;
	}
	:global(.dark) .verdict-warn {
		color: #fbbf24;
	}
</style>
