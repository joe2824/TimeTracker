<script lang="ts">
	import { onMount } from "svelte";
	import { app } from "$lib/app.svelte";
	import { listEntryMonths } from "$lib/store";
	import {
		clockToMin,
		durationHours,
		entryHours,
		fmtClock,
		fmtDate,
		fmtHoursClock,
		minToClock,
		monthLabel,
		parseClock,
		parseHours
	} from "$lib/time";
	import type { Entry, EntrySource } from "$lib/types";
	import { Button } from "$lib/components/ui/button";
	import { Input } from "$lib/components/ui/input";
	import { Label } from "$lib/components/ui/label";
	import * as Card from "$lib/components/ui/card";
	import * as Dialog from "$lib/components/ui/dialog";
	import CalendarImport from "$lib/components/CalendarImport.svelte";
	import BulkEntryDialog from "$lib/components/BulkEntryDialog.svelte";
	import VacationRange from "$lib/components/VacationRange.svelte";
	import PlusIcon from "@lucide/svelte/icons/plus";
	import Trash2Icon from "@lucide/svelte/icons/trash-2";
	import LayersIcon from "@lucide/svelte/icons/layers";
	import PalmtreeIcon from "@lucide/svelte/icons/palmtree";

	let month = $state(app.currentMonth);
	let months = $state<string[]>([]);
	let bulkOpen = $state(false);
	let vacOpen = $state(false);

	const WEEKDAYS = ["So", "Mo", "Di", "Mi", "Do", "Fr", "Sa"];

	interface Draft {
		id: string | null;
		originalStartTs: number;
		activityId: string;
		date: string;
		start: string;
		end: string;
		fraction: number;
		note: string;
		source: EntrySource;
	}

	let dialogOpen = $state(false);
	let draft = $state<Draft>(emptyDraft());
	let dur = $state(""); // Stunden-Eingabe, bidirektional mit Von/Bis
	let startText = $state(""); // Roh-Eingabe Von, erst beim Verlassen normalisiert
	let endText = $state(""); // Roh-Eingabe Bis
	const draftIsAbsence = $derived(app.isAbsenceId(draft.activityId));

	// Abwesenheiten werden über den "Abwesenheit"-Button erfasst und tauchen daher
	// nicht in der Aktivitäts-Auswahl auf – außer beim Bearbeiten eines bestehenden
	// Abwesenheits-Eintrags, damit dessen Aktivität sichtbar bleibt.
	const activityOptions = $derived(
		app.visibleActivities.filter((a) => !a.isAbsence || a.id === draft.activityId)
	);

	/** Stunden aus Von/Bis neu berechnen (z.B. 1.5). */
	function recalcDur() {
		const h = durationHours(draft.start, draft.end);
		dur = h ? String(Math.round(h * 100) / 100).replace(".", ",") : "";
	}
	/** Bis aus Von + Stunden-Eingabe ableiten. Akzeptiert "7,5" und "7:30". */
	function applyDur() {
		const h = parseHours(dur);
		const a = clockToMin(draft.start);
		if (h == null || a == null) return;
		draft.end = minToClock(a + h * 60);
		endText = draft.end;
	}

	/** Roh-Eingaben aus dem aktuellen Draft übernehmen. */
	function syncTimeText() {
		startText = draft.start;
		endText = draft.end;
	}

	/** Von-Eingabe beim Verlassen normalisieren (z.B. "1800" -> "18:00"). */
	function commitStart() {
		const p = parseClock(startText);
		if (p) {
			draft.start = p;
			recalcDur();
		}
		startText = draft.start;
	}

	/** Bis-Eingabe beim Verlassen normalisieren. */
	function commitEnd() {
		const p = parseClock(endText);
		if (p) {
			draft.end = p;
			recalcDur();
		}
		endText = draft.end;
	}

	function emptyDraft(): Draft {
		const now = new Date();
		const hh = String(now.getHours()).padStart(2, "0");
		return {
			id: null,
			originalStartTs: 0,
			activityId:
				app.visibleActivities.find((a) => !a.isAbsence)?.id ??
				app.visibleActivities[0]?.id ??
				"",
			date: fmtDate(now.getTime()),
			start: `${hh}:00`,
			end: `${hh}:00`,
			fraction: 1,
			note: "",
			source: "manual"
		};
	}

	async function refreshMonths() {
		const stored = await listEntryMonths();
		months = [...new Set([app.currentMonth, month, ...stored])].sort().reverse();
	}

	onMount(refreshMonths);
	$effect(() => {
		void app.ensureMonth(month);
	});

	// Alle Tage des Monats als Gitter.
	const days = $derived.by(() => {
		const [y, m] = month.split("-").map(Number);
		const count = new Date(y, m, 0).getDate();
		const byDate = new Map<string, Entry[]>();
		for (const e of app.monthEntries(month)) {
			const d = fmtDate(e.startTs);
			(byDate.get(d) ?? byDate.set(d, []).get(d)!).push(e);
		}
		const list = [];
		for (let d = 1; d <= count; d++) {
			const date = `${month}-${String(d).padStart(2, "0")}`;
			const wd = new Date(y, m - 1, d).getDay();
			const entries = (byDate.get(date) ?? []).sort((a, b) => a.startTs - b.startTs);
			const hours = entries.reduce(
				(s, e) => s + entryHours(e, app.isAbsenceId(e.activityId), app.settings.hoursPerDay, app.now),
				0
			);
			list.push({ d, date, weekday: WEEKDAYS[wd], weekend: wd === 0 || wd === 6, entries, hours });
		}
		return list;
	});

	const totalHours = $derived(days.reduce((s, day) => s + day.hours, 0));

	function openAdd(date?: string) {
		draft = emptyDraft();
		draft.date = date ?? `${month}-01`;
		recalcDur();
		syncTimeText();
		dialogOpen = true;
	}

	function openEdit(e: Entry) {
		const end = e.endTs ?? Date.now();
		draft = {
			id: e.id,
			originalStartTs: e.startTs,
			activityId: e.activityId,
			date: fmtDate(e.startTs),
			start: fmtClock(e.startTs),
			end: fmtClock(end),
			fraction: e.dayFraction ?? 1,
			note: e.note,
			source: e.source
		};
		recalcDur();
		syncTimeText();
		dialogOpen = true;
	}

	function toTs(date: string, time: string): number {
		return new Date(`${date}T${time}:00`).getTime();
	}

	async function save() {
		if (!draft.activityId) return;
		const absence = app.isAbsenceId(draft.activityId);
		if (!absence) {
			commitStart();
			commitEnd();
		}
		let startTs: number;
		let endTs: number;
		if (absence) {
			startTs = toTs(draft.date, "12:00");
			endTs = startTs;
		} else {
			startTs = toTs(draft.date, draft.start);
			endTs = toTs(draft.date, draft.end);
			if (endTs < startTs) endTs += 24 * 3600 * 1000;
		}
		if (Number.isNaN(startTs) || Number.isNaN(endTs)) return;

		if (draft.id) {
			const entry: Entry = {
				id: draft.id,
				activityId: draft.activityId,
				startTs,
				endTs,
				note: draft.note,
				source: draft.source
			};
			if (absence) entry.dayFraction = draft.fraction;
			const ok = await app.updateEntry(draft.originalStartTs, entry);
			if (!ok) return; // Tageskonflikt -> Dialog offen lassen
		} else {
			const created = await app.addEntry(
				draft.activityId,
				startTs,
				endTs,
				draft.note,
				"manual",
				absence ? draft.fraction : undefined
			);
			// Konflikt (z.B. Ganztags-Abwesenheit) -> addEntry hat null + Toast geliefert.
			if (!created) return;
		}
		dialogOpen = false;
		await refreshMonths();
	}

	function entryLabel(e: Entry): string {
		const name = app.activityName(e.activityId);
		if (app.isAbsenceId(e.activityId)) {
			return `${name} · ${(e.dayFraction ?? 1) === 0.5 ? "½ Tag" : "ganzer Tag"}`;
		}
		const h = entryHours(e, false, app.settings.hoursPerDay, app.now);
		return `${name} · ${fmtClock(e.startTs)}–${e.endTs ? fmtClock(e.endTs) : "…"} (${fmtHoursClock(h)} h)`;
	}
</script>

<div class="space-y-4">
	<div class="flex flex-wrap items-end justify-between gap-3">
		<div class="space-y-1">
			<Label for="month">Monat</Label>
			<select
				id="month"
				bind:value={month}
				class="border-input bg-background h-9 rounded-md border px-3 text-sm"
			>
				{#each months as m (m)}
					<option value={m}>{monthLabel(m)}</option>
				{/each}
			</select>
		</div>
		<div class="flex flex-wrap items-center gap-3">
			<span class="text-muted-foreground text-sm">Σ {fmtHoursClock(totalHours)} h</span>
			<Button variant="outline" onclick={() => (vacOpen = true)}>
				<PalmtreeIcon class="size-4" /> Abwesenheit
			</Button>
			<Button variant="outline" onclick={() => (bulkOpen = true)}>
				<LayersIcon class="size-4" /> Schnelleingabe
			</Button>
			<Button onclick={() => openAdd()}><PlusIcon class="size-4" /> Eintrag</Button>
		</div>
	</div>

	<Card.Root>
		<Card.Content class="p-0">
			<ul class="divide-border max-h-[55vh] divide-y overflow-y-auto">
				{#each days as day (day.date)}
					<li
						class="flex items-start gap-3 px-3 py-1.5 text-sm {day.weekend
							? 'bg-muted/60'
							: ''}"
					>
						<div class="w-14 shrink-0 pt-1">
							<div class="font-mono tabular-nums">{String(day.d).padStart(2, "0")}</div>
							<div class="text-muted-foreground text-xs">{day.weekday}</div>
						</div>
						<div class="flex-1 space-y-1 py-0.5">
							{#each day.entries as e (e.id)}
								<div class="group flex items-center gap-1">
									<button
										class="hover:bg-accent flex-1 truncate rounded px-1.5 py-0.5 text-left"
										onclick={() => openEdit(e)}
										title="Bearbeiten"
									>
										{entryLabel(e)}
									</button>
									<button
										class="text-muted-foreground hover:text-destructive opacity-0 group-hover:opacity-100"
										onclick={() => app.deleteEntry(e)}
										title="Löschen"
									>
										<Trash2Icon class="size-3.5" />
									</button>
								</div>
							{/each}
						</div>
						<div class="flex items-center gap-2 pt-0.5">
							{#if day.hours > 0}
								<span class="text-muted-foreground w-14 text-right font-mono text-xs tabular-nums">
									{fmtHoursClock(day.hours)} h
								</span>
							{:else}
								<span class="w-14"></span>
							{/if}
							<Button
								variant="ghost"
								size="icon"
								class="size-7"
								title="Eintrag für diesen Tag"
								onclick={() => openAdd(day.date)}
							>
								<PlusIcon class="size-4" />
							</Button>
						</div>
					</li>
				{/each}
			</ul>
		</Card.Content>
	</Card.Root>

	<CalendarImport {month} onimported={refreshMonths} />
</div>

<BulkEntryDialog bind:open={bulkOpen} {month} onsaved={refreshMonths} />

<VacationRange bind:open={vacOpen} onsaved={refreshMonths} />

<Dialog.Root bind:open={dialogOpen}>
	<Dialog.Content class="sm:max-w-md">
		<Dialog.Header>
			<Dialog.Title>{draft.id ? "Eintrag bearbeiten" : "Neuer Eintrag"}</Dialog.Title>
		</Dialog.Header>
		<div class="space-y-3">
			<div class="space-y-1">
				<Label for="act">Aktivität</Label>
				<select
					id="act"
					bind:value={draft.activityId}
					class="border-input bg-background h-9 w-full rounded-md border px-3 text-sm"
				>
					{#each activityOptions as a (a.id)}
						<option value={a.id}>{a.name}</option>
					{/each}
				</select>
			</div>

			{#if draftIsAbsence}
				<div class="grid grid-cols-2 gap-2">
					<div class="space-y-1">
						<Label for="date">Datum</Label>
						<Input id="date" type="date" bind:value={draft.date} />
					</div>
					<div class="space-y-1">
						<Label for="frac">Umfang</Label>
						<select
							id="frac"
							bind:value={draft.fraction}
							class="border-input bg-background h-9 w-full rounded-md border px-3 text-sm"
						>
							<option value={1}>Ganzer Tag ({fmtHoursClock(app.settings.hoursPerDay)} h)</option>
							<option value={0.5}>Halber Tag ({fmtHoursClock(app.settings.hoursPerDay / 2)} h)</option>
						</select>
					</div>
				</div>
			{:else}
				<div class="grid grid-cols-3 gap-2">
					<div class="col-span-3 space-y-1">
						<Label for="date">Datum</Label>
						<Input id="date" type="date" bind:value={draft.date} />
					</div>
					<div class="space-y-1">
						<Label for="start">Von</Label>
						<Input
							id="start"
							type="text"
							inputmode="numeric"
							placeholder="z. B. 1800"
							value={startText}
							oninput={(e) => (startText = e.currentTarget.value)}
							onchange={commitStart}
						/>
					</div>
					<div class="space-y-1">
						<Label for="end">Bis</Label>
						<Input
							id="end"
							type="text"
							inputmode="numeric"
							placeholder="z. B. 1830"
							value={endText}
							oninput={(e) => (endText = e.currentTarget.value)}
							onchange={commitEnd}
						/>
					</div>
					<div class="space-y-1">
						<Label for="dur">Stunden</Label>
						<Input
							id="dur"
							type="text"
							inputmode="decimal"
							placeholder="z. B. 7,5 · 7:30 · 0741"
							value={dur}
							oninput={(e) => {
								dur = e.currentTarget.value;
								applyDur();
							}}
						/>
					</div>
				</div>
			{/if}

		</div>
		<Dialog.Footer>
			<Button variant="outline" onclick={() => (dialogOpen = false)}>Abbrechen</Button>
			<Button onclick={save}>Speichern</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
