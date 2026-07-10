<script lang="ts">
	import { app } from "$lib/app.svelte";
	import {
		readOutlookCalendar,
		detectOutlook,
		explainOutlookError,
		type CalendarEvent
	} from "$lib/outlook";
	import { allDayNoons, fmtDate, isWorkday } from "$lib/time";
	import { Button } from "$lib/components/ui/button";
	import { Badge } from "$lib/components/ui/badge";
	import * as Card from "$lib/components/ui/card";
	import { toast } from "svelte-sonner";
	import CalendarIcon from "@lucide/svelte/icons/calendar";
	import LoaderCircleIcon from "@lucide/svelte/icons/loader-circle";
	import PalmtreeIcon from "@lucide/svelte/icons/palmtree";
	import CheckIcon from "@lucide/svelte/icons/check";

	let {
		month,
		onimported,
		previewActive = $bindable(false)
	}: { month: string; onimported: () => void; previewActive?: boolean } = $props();

	let loading = $state(false);
	let applying = $state(false);
	let events = $state<CalendarEvent[]>([]);
	/** pro Event: gewaehlte activityId ("" = ignorieren) */
	let mapping = $state<string[]>([]);
	let loaded = $state(false);
	// true, sobald „Termine laden" gedrückt wurde -> große Import-Ansicht (Monatsliste aus).
	let active = $state(false);

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

	/** Fällt (mindestens ein Tag) des Termins auf einen regulären Arbeitstag? */
	function eventHasWorkday(ev: CalendarEvent): boolean {
		const start = new Date(ev.start).getTime();
		if (ev.allDay) {
			return allDayNoons(start, new Date(ev.end).getTime()).some((ts) =>
				isWorkday(ts, app.settings.workdays)
			);
		}
		return isWorkday(start, app.settings.workdays);
	}

	// ---- Duplikat-Erkennung: bereits importierte Termine (source="calendar") ----
	const monthOf = (ts: number) => fmtDate(ts).slice(0, 7);

	/** Existiert schon eine importierte Abwesenheit mit gleichem Tag + Betreff? */
	function dayAlreadyImported(dayTs: number, subject: string): boolean {
		const dstr = fmtDate(dayTs);
		return app
			.monthEntries(monthOf(dayTs))
			.some(
				(e) =>
					e.source === "calendar" &&
					app.isAbsenceId(e.activityId) &&
					e.note === subject &&
					fmtDate(e.startTs) === dstr
			);
	}

	/** Existiert schon ein importierter Zeit-Eintrag mit gleichem Start/Ende/Betreff? */
	function timedAlreadyImported(startTs: number, endTs: number, subject: string): boolean {
		return app
			.monthEntries(monthOf(startTs))
			.some(
				(e) =>
					e.source === "calendar" &&
					e.note === subject &&
					e.startTs === startTs &&
					e.endTs === endTs
			);
	}

	/** Ist der Termin (bzw. all seine Arbeitstage) bereits importiert? */
	function alreadyImported(ev: CalendarEvent): boolean {
		const startTs = new Date(ev.start).getTime();
		const endTs = new Date(ev.end).getTime();
		if (Number.isNaN(startTs) || Number.isNaN(endTs)) return false;
		if (ev.allDay) {
			const days = allDayNoons(startTs, endTs).filter((ts) =>
				isWorkday(ts, app.settings.workdays)
			);
			return days.length > 0 && days.every((ts) => dayAlreadyImported(ts, ev.subject));
		}
		return timedAlreadyImported(startTs, endTs, ev.subject);
	}

	async function load() {
		if (loading) return; // kein Doppel-Start
		// Sofort in die große Import-Ansicht wechseln (Monatsliste ausblenden).
		active = true;
		loaded = false;
		loading = true;
		try {
			const [y, m] = month.split("-").map(Number);
			const start = `${month}-01`;
			const end = fmtDate(new Date(y, m, 0).getTime());
			events = await readOutlookCalendar(start, end);
			// Termine ohne Arbeitstag oder bereits importierte standardmäßig auf „ignorieren".
			mapping = events.map((ev) =>
				eventHasWorkday(ev) && !alreadyImported(ev) ? guessActivity(ev) : ""
			);
			loaded = true;
		} catch (e) {
			const info = await detectOutlook().catch(() => null);
			toast.error(`Outlook-Kalender konnte nicht gelesen werden: ${explainOutlookError(e, info)}`);
			active = false; // bei Fehler zurück zur Normalansicht
		} finally {
			loading = false;
		}
	}

	// Solange die Import-Ansicht aktiv ist, blendet die übergeordnete Ansicht die
	// Monatsliste aus (nur ein Scrollbereich).
	$effect(() => {
		previewActive = active;
	});

	/** Import-Ansicht schließen und zur Normalansicht (Einträge) zurück. */
	function cancel() {
		if (applying) return;
		events = [];
		mapping = [];
		loaded = false;
		active = false;
	}

	async function apply() {
		if (applying) return; // kein Doppel-Import
		applying = true;
		try {
			await doApply();
		} finally {
			applying = false;
		}
	}

	async function doApply() {
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
				// Ganztägig (evtl. mehrtägig): für JEDEN Arbeitstag im Bereich einen ganzen Abwesenheitstag.
				for (const dayTs of allDayNoons(startTs, endTs)) {
					if (!isWorkday(dayTs, app.settings.workdays)) continue;
					await app.ensureMonth(monthOf(dayTs));
					if (dayAlreadyImported(dayTs, ev.subject)) continue; // schon importiert -> überspringen
					const created = await app.addEntry(activityId, dayTs, dayTs, ev.subject, "calendar", 1);
					if (created) count++;
				}
			} else {
				// Wochenenden/freie Tage nicht importieren – sind keine Arbeitstage.
				if (!isWorkday(startTs, app.settings.workdays)) continue;
				await app.ensureMonth(monthOf(startTs));
				if (timedAlreadyImported(startTs, endTs, ev.subject)) continue; // schon importiert
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
		if (count > 0) toast.success(`${count} Kalendereintrag/-einträge übernommen.`);
		else toast.info("Keine neuen Termine – alles bereits importiert oder ignoriert.");
		events = [];
		loaded = false;
		active = false; // zurück zur Normalansicht
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
				{#if loading}<LoaderCircleIcon class="size-4 animate-spin" />{/if}
				{loading ? "Lädt…" : "Termine laden"}
			</Button>
		</Card.Action>
	</Card.Header>
	{#if loading}
		<Card.Content class="space-y-2">
			<div class="text-muted-foreground flex items-center gap-2 text-sm">
				<LoaderCircleIcon class="size-4 shrink-0 animate-spin" />
				Termine werden aus Outlook geladen… Das klassische Outlook kann beim ersten Zugriff kurz
				brauchen.
			</div>
			<!-- Indeterminater Ladebalken -->
			<div class="bg-muted h-1.5 w-full overflow-hidden rounded-full">
				<div
					class="bg-primary h-full w-1/3 rounded-full animate-[indeterminate_1.1s_ease-in-out_infinite]"
				></div>
			</div>
		</Card.Content>
	{:else if active && loaded && events.length === 0}
		<Card.Content class="space-y-3 py-6 text-center">
			<p class="text-muted-foreground text-sm">
				Keine Termine zum Importieren in diesem Monat gefunden.
			</p>
			<Button variant="outline" size="sm" onclick={cancel}>Zurück zu Einträgen</Button>
		</Card.Content>
	{:else if active && loaded && events.length > 0}
		{#snippet actions()}
			<div class="flex justify-end gap-2">
				<Button variant="outline" size="sm" onclick={cancel} disabled={applying}>Abbrechen</Button>
				<Button size="sm" onclick={apply} disabled={applying}>
					{#if applying}<LoaderCircleIcon class="size-4 animate-spin" />{/if}
					{applying ? "Übernehme…" : "Übernehmen"}
				</Button>
			</div>
		{/snippet}
		<Card.Content class="p-0">
			<div class="px-6 pb-3">{@render actions()}</div>
			<ul class="divide-border max-h-[calc(100vh-22rem)] divide-y overflow-y-auto border-y text-sm">
				{#each events as ev, i (ev.start + ev.subject)}
					{@const hasWorkday = eventHasWorkday(ev)}
						{@const isAbs = !!mapping[i] && app.isAbsenceId(mapping[i])}
						{@const alreadyImp = alreadyImported(ev)}
					<li class="flex flex-wrap items-center gap-3 px-4 py-1.5 {hasWorkday && !alreadyImp ? '' : 'opacity-60'} {isAbs ? 'bg-amber-500/15' : ''}">
						<span class="text-muted-foreground w-28 shrink-0 font-mono text-xs">
							{fmtDate(new Date(ev.start).getTime()).slice(5)}
							{new Date(ev.start).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" })}
						</span>
						<span class="flex min-w-40 flex-1 items-center gap-1.5">
							{#if isAbs}
								<PalmtreeIcon class="size-3.5 shrink-0 text-amber-600 dark:text-amber-400" />
							{/if}
							<span class="truncate {isAbs ? 'font-medium text-amber-700 dark:text-amber-300' : ''}">
								{ev.subject || "(ohne Titel)"}
							</span>
						</span>
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
						{#if !hasWorkday}
							<Badge variant="outline" class="text-muted-foreground">kein Arbeitstag</Badge>
						{:else if alreadyImp}
							<Badge variant="secondary" class="gap-1">
								<CheckIcon class="size-3.5" /> bereits importiert
							</Badge>
						{:else}
							<select
								bind:value={mapping[i]}
								class="border-input bg-background h-8 rounded-md border px-2 text-xs"
							>
								<option value="">— ignorieren —</option>
								{#each app.visibleActivities as a (a.id)}
									<option value={a.id}>{a.name}</option>
								{/each}
							</select>
						{/if}
					</li>
				{/each}
			</ul>
			<div class="px-6 pt-3">{@render actions()}</div>
		</Card.Content>
	{/if}
</Card.Root>
