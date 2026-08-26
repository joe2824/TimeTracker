<script lang="ts">
	// Mehrere Projekte mit Anteilen belegen – die Schätzung für einen Zeitraum,
	// den man im Nachhinein nicht mehr stundengenau auseinandersortieren kann
	// („grob 60 % MCB, 40 % FFX").
	import { Button } from "$lib/components/ui/button";
	import ActivityCombobox from "$lib/components/ActivityCombobox.svelte";
	import PlusIcon from "@lucide/svelte/icons/plus";
	import XIcon from "@lucide/svelte/icons/x";
	import { fmtHoursClock } from "$lib/time";
	import type { Activity } from "$lib/types";
	import { rebalanceShares, type Share, type SplitMode } from "$lib/timeReconcile";

	let {
		options,
		days,
		hours,
		onApply
	}: {
		options: Activity[];
		/** Wie viele Tage die Verteilung treffen würde. */
		days: number;
		/** Wie viele Stunden auf diesen Tagen nachzutragen sind. */
		hours: number;
		onApply: (shares: Share[], mode: SplitMode) => void;
	} = $props();

	/** Farben in der Reihenfolge der Zeilen – Balken und Punkt gehören zusammen. */
	const COLORS = [
		"bg-primary",
		"bg-sky-500",
		"bg-amber-500",
		"bg-emerald-500",
		"bg-violet-500",
		"bg-rose-500"
	];

	let mode = $state<SplitMode>("within");
	// Prozent als ganze Zahlen: Regler und Anzeige rechnen damit ohne Rundungsstaub.
	let parts = $state<{ id: string; pct: number }[]>([
		{ id: "", pct: 50 },
		{ id: "", pct: 50 }
	]);

	const ready = $derived(parts.filter((p) => p.id && p.pct > 0).length >= 1);
	/** Dasselbe Projekt zweimal: das würde zwei Einträge nebeneinander ergeben. */
	const duplicate = $derived.by(() => {
		const ids = parts.map((p) => p.id).filter(Boolean);
		return new Set(ids).size !== ids.length;
	});

	/**
	 * Einen Regler setzen und den Rest auf die anderen verteilen – im Verhältnis
	 * ihrer bisherigen Werte, damit ein Zug an einem Regler die übrigen nicht
	 * durcheinanderwirft.
	 */
	function setPct(i: number, value: number) {
		const next = rebalanceShares(
			parts.map((p) => p.pct),
			i,
			value
		);
		parts.forEach((p, k) => (p.pct = next[k]));
	}

	function addPart() {
		if (parts.length >= COLORS.length) return;
		parts.push({ id: "", pct: 0 });
		// Der neue bekommt seinen gleichen Anteil, die anderen rücken zusammen.
		setPct(parts.length - 1, Math.round(100 / parts.length));
	}

	function removePart(i: number) {
		if (parts.length <= 1) return;
		parts.splice(i, 1);
		// Auf 100 % nachziehen: der frei gewordene Anteil gehört den übrigen.
		const sum = parts.reduce((s, p) => s + p.pct, 0);
		if (sum === 0) parts.forEach((p) => (p.pct = Math.round(100 / parts.length)));
		setPct(0, sum === 0 ? parts[0].pct : Math.round((parts[0].pct / sum) * 100));
	}

	function apply() {
		onApply(
			parts.filter((p) => p.id && p.pct > 0).map((p) => ({ id: p.id, share: p.pct / 100 })),
			mode
		);
	}
</script>

<div class="space-y-3 rounded-lg border p-3">
	<div class="flex flex-wrap items-center justify-between gap-2">
		<p class="text-sm font-medium">Auf mehrere Projekte verteilen</p>
		<!-- Segmentiert statt Auswahlliste: es sind genau zwei Möglichkeiten, und
		     welche gerade gilt, ändert das Ergebnis sichtbar. -->
		<div class="bg-muted flex gap-0.5 rounded-md p-0.5">
			<Button
				variant={mode === "within" ? "default" : "ghost"}
				size="sm"
				class="h-7"
				onclick={() => (mode = "within")}
			>
				Innerhalb des Tages
			</Button>
			<Button
				variant={mode === "days" ? "default" : "ghost"}
				size="sm"
				class="h-7"
				onclick={() => (mode = "days")}
			>
				Tageweise
			</Button>
		</div>
	</div>

	<!-- Der Balken ist die eigentliche Auskunft: das Verhältnis auf einen Blick. -->
	<div class="bg-muted flex h-2.5 overflow-hidden rounded-full">
		{#each parts as p, i (i)}
			<div class="{COLORS[i % COLORS.length]} transition-all" style={`width:${p.pct}%`}></div>
		{/each}
	</div>

	<div class="space-y-2">
		{#each parts as p, i (i)}
			<div class="flex flex-wrap items-center gap-2">
				<span class="{COLORS[i % COLORS.length]} size-2.5 shrink-0 rounded-full"></span>
				<div class="w-52">
					<ActivityCombobox id={`split-${i}`} bind:value={p.id} {options} placeholder="Projekt wählen" />
				</div>
				<!-- Nativer Regler: bringt Tastaturbedienung und Zeigergesten mit, ohne
				     dass dafür eine weitere Komponente nötig wäre. -->
				<input
					type="range"
					min="0"
					max="100"
					step="1"
					value={p.pct}
					oninput={(e) => setPct(i, e.currentTarget.valueAsNumber)}
					aria-label={`Anteil ${i + 1}`}
					class="accent-primary h-2 min-w-32 flex-1 cursor-pointer"
				/>
				<span class="w-11 text-right font-mono text-sm tabular-nums">{p.pct}%</span>
				<span class="text-muted-foreground w-16 text-right font-mono text-xs tabular-nums">
					{fmtHoursClock((hours * p.pct) / 100)} h
				</span>
				<Button
					variant="ghost"
					size="icon"
					class="size-7"
					disabled={parts.length <= 1}
					aria-label="Projekt entfernen"
					onclick={() => removePart(i)}
				>
					<XIcon class="size-3.5" />
				</Button>
			</div>
		{/each}
	</div>

	<div class="flex flex-wrap items-center justify-between gap-2">
		<Button variant="outline" size="sm" onclick={addPart} disabled={parts.length >= COLORS.length}>
			<PlusIcon class="size-3.5" /> Projekt
		</Button>
		<div class="flex flex-wrap items-center gap-3">
			<span class="text-muted-foreground text-xs">
				{#if duplicate}
					<span class="text-amber-700 dark:text-amber-300">Ein Projekt ist doppelt gewählt.</span>
				{:else if days === 0}
					Erst Tage auswählen
				{:else if mode === "within"}
					{days} Tag{days === 1 ? "" : "e"} · jeder Tag wird geschnitten
				{:else}
					{days} Tag{days === 1 ? "" : "e"} · jeder Tag geht ganz an ein Projekt
				{/if}
			</span>
			<Button size="sm" onclick={apply} disabled={!ready || days === 0 || duplicate}>Verteilen</Button>
		</div>
	</div>
</div>
