<script lang="ts">
	import { app } from "$lib/app.svelte";
	import {
		readOutlookCalendar,
		detectOutlook,
		explainOutlookError,
		type CalendarEvent
	} from "$lib/outlook";
	import { allDayNoons, fmtDate } from "$lib/time";
	import { Button } from "$lib/components/ui/button";
	import { Badge } from "$lib/components/ui/badge";
	import * as Card from "$lib/components/ui/card";
	import { toast } from "svelte-sonner";
	import CalendarIcon from "@lucide/svelte/icons/calendar";

	let { month, onimported }: { month: string; onimported: () => void } = $props();

	let loading = $state(false);
	let events = $state<CalendarEvent[]>([]);
	/** pro Event: gewaehlte activityId ("" = ignorieren) */
	let mapping = $state<string[]>([]);
	let loaded = $state(false);

	function guessActivity(ev: CalendarEvent): string {
		// Ganztägig oder "abwesend" -> Abwesenheiten
		if (ev.allDay || ev.busyStatus === 3) {
			return app.absenceActivity?.id ?? "";
		}
		const subj = ev.subject.toLowerCase();
		for (const [kw, id] of Object.entries(app.settings.calendarKeywordMap)) {
			if (kw && subj.includes(kw)) return id;
		}
		// Name-Treffer
		const hit = app.visibleActivities.find((a) => subj.includes(a.name.toLowerCase()));
		return hit?.id ?? "";
	}

	async function load() {
		loading = true;
		try {
			const [y, m] = month.split("-").map(Number);
			const start = `${month}-01`;
			const end = fmtDate(new Date(y, m, 0).getTime());
			events = await readOutlookCalendar(start, end);
			mapping = events.map(guessActivity);
			loaded = true;
			if (events.length === 0) toast.info("Keine Kalendereinträge in diesem Monat gefunden.");
		} catch (e) {
			const info = await detectOutlook().catch(() => null);
			toast.error(`Outlook-Kalender konnte nicht gelesen werden: ${explainOutlookError(e, info)}`);
		} finally {
			loading = false;
		}
	}

	async function apply() {
		let count = 0;
		const newMap = { ...app.settings.calendarKeywordMap };
		for (let i = 0; i < events.length; i++) {
			const activityId = mapping[i];
			if (!activityId) continue;
			const ev = events[i];
			const startTs = new Date(ev.start).getTime();
			const endTs = new Date(ev.end).getTime();
			if (Number.isNaN(startTs) || Number.isNaN(endTs)) continue;
			const isAbsence = app.isAbsenceId(activityId);

			if (isAbsence && ev.allDay) {
				// Ganztägig (evtl. mehrtägig): für JEDEN Tag im Bereich einen ganzen Abwesenheitstag.
				for (const dayTs of allDayNoons(startTs, endTs)) {
					const created = await app.addEntry(activityId, dayTs, dayTs, ev.subject, "calendar", 1);
					if (created) count++;
				}
			} else {
				// Abwesenheit mit Uhrzeit -> halber Tag; sonst normaler Zeiteintrag.
				const dayFraction = isAbsence ? 0.5 : undefined;
				const created = await app.addEntry(
					activityId,
					startTs,
					endTs,
					ev.subject,
					"calendar",
					dayFraction
				);
				if (created) count++;
			}
			newMap[ev.subject.toLowerCase()] = activityId; // fuer naechstes Mal merken
		}
		await app.updateSettings({ calendarKeywordMap: newMap });
		toast.success(`${count} Kalendereintrag/-einträge übernommen.`);
		events = [];
		loaded = false;
		onimported();
	}

	function busyLabel(s: number): string {
		return ["frei", "vorbehalt", "gebucht", "abwesend", "woanders"][s] ?? String(s);
	}
</script>

<Card.Root>
	<Card.Header>
		<Card.Title class="flex items-center gap-2"><CalendarIcon class="size-4" /> Outlook-Kalender</Card.Title>
		<Card.Description>
			Termine des Monats importieren und auf Aktivitäten verteilen. Ganztägige/abwesend-Termine
			gehen automatisch in „Abwesenheiten“.
		</Card.Description>
		<Card.Action>
			<Button variant="outline" size="sm" onclick={load} disabled={loading}>
				{loading ? "Lädt…" : "Termine laden"}
			</Button>
		</Card.Action>
	</Card.Header>
	{#if loaded && events.length > 0}
		<Card.Content class="space-y-2">
			<ul class="divide-border divide-y text-sm">
				{#each events as ev, i (ev.start + ev.subject)}
					<li class="flex flex-wrap items-center gap-2 py-2">
						<span class="text-muted-foreground w-28 shrink-0 font-mono text-xs">
							{fmtDate(new Date(ev.start).getTime()).slice(5)}
							{new Date(ev.start).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" })}
						</span>
						<span class="min-w-40 flex-1">{ev.subject || "(ohne Titel)"}</span>
						{#if ev.allDay}
							{@const nDays = allDayNoons(
								new Date(ev.start).getTime(),
								new Date(ev.end).getTime()
							).length}
							<Badge variant="secondary">
								{nDays > 1 ? `ganztägig · ${nDays} Tage` : "ganztägig"}
							</Badge>
						{/if}
						<Badge variant="outline">{busyLabel(ev.busyStatus)}</Badge>
						<select
							bind:value={mapping[i]}
							class="border-input bg-background h-8 rounded-md border px-2 text-xs"
						>
							<option value="">— ignorieren —</option>
							{#each app.visibleActivities as a (a.id)}
								<option value={a.id}>{a.name}</option>
							{/each}
						</select>
					</li>
				{/each}
			</ul>
			<div class="flex justify-end">
				<Button onclick={apply}>Übernehmen</Button>
			</div>
		</Card.Content>
	{/if}
</Card.Root>
