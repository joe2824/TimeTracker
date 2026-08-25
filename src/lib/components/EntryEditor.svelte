<script lang="ts">
	import { tick } from "svelte";
	import { toast } from "svelte-sonner";
	import { app } from "$lib/app.svelte";
	import { entriesFocus } from "$lib/entriesFocus.svelte";
	import {
		clockToMin,
		durationHours,
		entryHours,
		fmtClock,
		fmtDate,
		fmtDateHuman,
		fmtHoursClock,
		keepSeconds,
		midnightSplitHint,
		minToClock,
		noonTs,
		openEntryUntil,
		startOfNextDay,
		parseClock,
		parseHours,
		toTs
	} from "$lib/time";
	import { daysInMonth, weekdayOfDate, zonedParts } from "$lib/tz";
	import type { Entry, EntrySource } from "$lib/types";
	import { loadTimeReport, type StoredTimeReport } from "$lib/store";
	import {
		reconcile,
		targetEntryHours,
		type Interval,
		type ReconcileDay
	} from "$lib/timeReconcile";
	import { breakDeduction } from "$lib/breaks";
	import { Button } from "$lib/components/ui/button";
	import { Input } from "$lib/components/ui/input";
	import { Label } from "$lib/components/ui/label";
	import * as Card from "$lib/components/ui/card";
	import * as Dialog from "$lib/components/ui/dialog";
	import CalendarImport from "$lib/components/CalendarImport.svelte";
	import TimeReportImport from "$lib/components/TimeReportImport.svelte";
	import ActivityCombobox from "$lib/components/ActivityCombobox.svelte";
	import DateInput from "$lib/components/DateInput.svelte";
	import BulkEntryDialog from "$lib/components/BulkEntryDialog.svelte";
	import VacationRange from "$lib/components/VacationRange.svelte";
	import MonthSelector from "$lib/components/MonthSelector.svelte";
	import DayFractionSwitch from "$lib/components/DayFractionSwitch.svelte";
	import PlusIcon from "@lucide/svelte/icons/plus";
	import Trash2Icon from "@lucide/svelte/icons/trash-2";
	import CalendarDaysIcon from "@lucide/svelte/icons/calendar-days";
	import PalmtreeIcon from "@lucide/svelte/icons/palmtree";

	let month = $state(app.currentMonth);
	let bulkOpen = $state(false);
	let vacOpen = $state(false);
	// true, solange der Kalender-Import eine Termin-Vorschau zeigt -> Monatsliste ausblenden.
	let importPreview = $state(false);
	// dito fuer den Abgleich mit dem Zeitwirtschaftsreport.
	let reportPreview = $state(false);
	const anyPreview = $derived(importPreview || reportPreview);

	/** Ab welcher Abweichung ein Tag auffaellt (Stunden) – wie im Abgleich: 15 Minuten. */
	const REPORT_TOLERANCE = 0.25;
	/** Der eingelesene LOGA-Report dieses Monats, falls einer vorliegt. */
	let report = $state<StoredTimeReport | null>(null);
	const absenceIds = $derived(new Set(app.activities.filter((a) => a.isAbsence).map((a) => a.id)));

	/**
	 * Der Abgleich dieses Monats, Tag fuer Tag.
	 *
	 * Bewusst ueber `reconcile` statt mit einer eigenen Differenz: die Karte
	 * „Zeitwächter-Report" rechnet damit, und zwei Rechnungen fuer denselben Tag
	 * saehen frueher oder spaeter verschieden aus – Pausenabzug, Abwesenheiten und
	 * angefangene Tage stecken alle da drin.
	 */
	const reportByDate = $derived.by(() => {
		const out = new Map<string, ReconcileDay>();
		if (!report) return out;
		const summary = reconcile(report.days, app.monthEntries(month), {
			hoursPerDay: app.settings.hoursPerDay,
			tolerance: REPORT_TOLERANCE,
			absenceIds,
			now: app.now,
			deductBreaks: app.settings.breakDeduction
		});
		for (const d of summary.days) out.set(d.date, d);
		return out;
	});

	// Nach dem Schliessen des Abgleichs neu lesen: dort kann gerade ein Report
	// eingelesen oder gewechselt worden sein. `entriesVersion` haengt mit dran,
	// weil „Einstellungen → Daten → Jahr loeschen" die Reports des Jahres
	// mitnimmt – ohne das blieben die Fehlbetrags-Markierungen stehen.
	$effect(() => {
		const m = month;
		void reportPreview;
		void app.entriesVersion;
		void loadTimeReport(m)
			.then((r) => {
				if (month === m) report = r;
			})
			.catch(() => {});
	});

	const WEEKDAYS = ["So", "Mo", "Di", "Mi", "Do", "Fr", "Sa"];

	// Von/Bis sind Uhrzeiten eines Tages; laeuft Bis vor Von, gilt der Folgetag.
	// Damit ist die laengste darstellbare Spanne knapp unter 24 h – bei genau 24 h
	// waere das Ende wieder der Start, also ein 0-Stunden-Eintrag.
	const MAX_ENTRY_HOURS = 24;

	interface Draft {
		id: string | null;
		originalStartTs: number;
		/** Gespeichertes Ende, sekundengenau – Grundlage fuer `keepSeconds`. */
		originalEndTs: number | null;
		activityId: string;
		date: string;
		start: string;
		end: string;
		fraction: number;
		note: string;
		source: EntrySource;
	}

	let dialogOpen = $state(false);
	let dialogEl = $state<HTMLElement | null>(null);
	let draft = $state<Draft>(emptyDraft());
	let dur = $state(""); // Stunden-Eingabe, bidirektional mit Von/Bis
	let startText = $state(""); // Roh-Eingabe Von, erst beim Verlassen normalisiert
	let endText = $state(""); // Roh-Eingabe Bis
	const draftIsAbsence = $derived(app.isAbsenceId(draft.activityId));
	/**
	 * Warnung beim Öffnen: der gespeicherte Eintrag passt nicht in Datum + Von/Bis.
	 *
	 * Der Dialog kennt nur EIN Datum und zwei Uhrzeiten. Ein Eintrag über mehrere
	 * Tage (vergessener Timer) sah darin völlig unauffällig aus – 09:00–17:00 –,
	 * während die Liste daneben 73 Stunden zeigte und der Bericht sie übernahm.
	 * Lieber sagen, was wirklich gespeichert ist.
	 */
	let spanNote = $state<string | null>(null);

	/**
	 * Hinweis, dass aus dem Entwurf zwei Einträge werden (Von 23:00 / Bis 01:00).
	 * Rechnet dieselbe Folgetag-Regel wie save(), sonst zeigte der Hinweis etwas
	 * anderes an, als am Ende gespeichert wird.
	 */
	const splitHint = $derived.by(() => {
		if (draftIsAbsence) return null;
		const s = toTs(draft.date, startText || draft.start);
		let e = toTs(draft.date, endText || draft.end);
		if (Number.isNaN(s) || Number.isNaN(e)) return null;
		if (e < s) e = toTs(fmtDate(startOfNextDay(s)), endText || draft.end);
		if (Number.isNaN(e) || e <= s) return null;
		const geteilt = midnightSplitHint(s, e);
		return geteilt ? `Geht ${geteilt}: ${fmtDateHuman(s)} und ${fmtDateHuman(e)}.` : null;
	});

	// Die Uhrzeiten, wie sie GERADE im Dialog stehen – auch wenn ein Feld noch nicht
	// verlassen wurde. Sonst rechnete der Zeitwächter-Hinweis darunter mit dem Stand
	// von vorhin weiter.
	const draftStart = $derived(parseClock(startText) ?? draft.start);
	const draftEnd = $derived(parseClock(endText) ?? draft.end);

	/**
	 * Was der Zeitwächter zum Tag des Entwurfs sagt – und auf welche Dauer dieser
	 * eine Eintrag gesetzt werden müsste, damit der Tag zu LOGA passt.
	 *
	 * Gerechnet wird über die ANDEREN Einträge des Tages, nicht über die aktuelle
	 * Abweichung. Nur so stimmt die Zahl auch dann noch, wenn im Dialog schon an
	 * den Zeiten gedreht wurde – und ein zweiter Klick verdoppelt nichts.
	 */
	const dayAdjust = $derived.by(() => {
		if (draftIsAbsence) return null;
		const rd = reportByDate.get(draft.date);
		// „ok"/„free" heißt: nichts zu holen. Bei „open" kennt LOGA den Feierabend
		// noch nicht – jede Korrektur wäre dort geraten.
		if (!rd || rd.status === "ok" || rd.status === "free" || rd.status === "open") return null;

		// Der bearbeitete Eintrag zählt nicht mit: seine Dauer ist die Stellschraube.
		let othersWorked = 0;
		let othersAbsent = 0;
		for (const e of app.monthEntries(draft.date.slice(0, 7))) {
			if (e.id === draft.id || fmtDate(e.startTs) !== draft.date) continue;
			const isAbs = app.isAbsenceId(e.activityId);
			// Gekappt wie in `reconcile`: ein vergessener offener Eintrag zaehlte sonst
			// bis jetzt weiter, und der Hinweis hier widerspräche dem Badge daneben.
			const h = entryHours(e, isAbs, app.settings.hoursPerDay, openEntryUntil(e, app.now));
			if (isAbs) othersAbsent += h;
			else othersWorked += h;
		}

		const target = targetEntryHours(
			rd.report.hours,
			othersWorked,
			othersAbsent,
			app.settings.breakDeduction
		);
		const targetMin = Math.round(target * 60);
		const delta = Math.round(targetMin - durationHours(draftStart, draftEnd) * 60) / 60;

		// Wohin der Eintrag käme. Bevorzugt bleibt „Von" stehen und „Bis" wandert;
		// reicht der Tag dahinter nicht mehr, andersherum. Über Mitternacht zu
		// laufen wäre hier das Gegenteil von hilfreich: `save()` macht daraus zwei
		// Einträge, und der Tag bekäme nur den ersten Teil – ein neuer Eintrag am
		// Abend erwischt das sofort, weil er mit der aktuellen Stunde startet.
		const from = clockToMin(draftStart);
		const to = clockToMin(draftEnd);
		let block: Interval | null = null;
		if (targetMin > 0 && targetMin <= MAX_ENTRY_HOURS * 60) {
			if (from != null && from + targetMin <= 1440) block = { start: from, end: from + targetMin };
			else if (to != null && to - targetMin >= 0) block = { start: to - targetMin, end: to };
		}

		return {
			reportHours: rd.report.hours,
			delta,
			// Null Minuten sind kein Eintrag, und was nicht in den Tag passt, geht
			// hier nicht. Wer den Tag so leeren will, löscht den Eintrag.
			block: delta !== 0 ? block : null
		};
	});

	/** Den Entwurf auf `dayAdjust.block` setzen – die Dauer trifft dann die LOGA-Stunden. */
	function applyDayAdjust() {
		const block = dayAdjust?.block;
		if (!block) return;
		// Fokus JETZT weg vom Knopf, noch vor der Änderung: passt der Tag danach,
		// verschwindet der Knopf – und ein Fokus, der mit seinem Element entfernt
		// wird, lässt den Fokus-Fang des Dialogs von vorn anfangen. Der landete auf
		// der Aktivitäts-Combobox, die daraufhin ihre Liste über die Felder klappt.
		dialogEl?.focus();
		draft.start = minToClock(block.start);
		// 24:00 wird zu "00:00" – save() liest das als Folgetag und trifft damit
		// genau die Tagesgrenze, ohne zu teilen.
		draft.end = minToClock(block.end);
		syncTimeText();
		recalcDur();
	}

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
	/**
	 * Bis aus Von + Stunden-Eingabe ableiten. Akzeptiert "7,5" und "7:30".
	 *
	 * Ueber 24 h wird abgelehnt statt gerechnet: minToClock rechnet modulo 24 h,
	 * aus "30" wuerde sonst still ein Ende 6 h nach dem Start – die Eingabe kaeme
	 * als 6-Stunden-Eintrag zurueck, ohne Fehler.
	 */
	function applyDur() {
		const h = parseHours(dur);
		const a = clockToMin(draft.start);
		if (h == null || a == null) return;
		if (h >= MAX_ENTRY_HOURS) {
			toast.error(`Ein Eintrag muss kürzer als ${MAX_ENTRY_HOURS} Stunden sein.`);
			recalcDur();
			return;
		}
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
		const hh = String(zonedParts(Date.now()).hour).padStart(2, "0");
		return {
			id: null,
			originalStartTs: 0,
			originalEndTs: null,
			// Bewusst leer: der Nutzer wählt die Aktivität selbst (kein Default).
			activityId: "",
			date: fmtDate(Date.now()),
			start: `${hh}:00`,
			end: `${hh}:00`,
			fraction: 1,
			note: "",
			source: "manual"
		};
	}

	$effect(() => {
		void app.ensureMonth(month);
	});

	/** Auf den Monat des Tages wechseln und ihn mittig in die Liste scrollen. */
	async function jumpToDate(date: string) {
		const targetMonth = date.slice(0, 7);
		if (month !== targetMonth) {
			month = targetMonth;
			await app.ensureMonth(targetMonth);
		}
		await tick(); // Warten, bis die Tage neu gerendert sind.
		document
			.getElementById(`day-row-${date}`)
			?.scrollIntoView({ block: "center", behavior: "smooth" });
	}

	// Wunsch aus Tracking oder Arbeitszeit-Check konsumieren.
	$effect(() => {
		const date = entriesFocus.pendingDate;
		if (date) {
			entriesFocus.pendingDate = null;
			void jumpToDate(date);
		}
	});

	// Alle Tage des Monats als Gitter.
	const days = $derived.by(() => {
		const [y, m] = month.split("-").map(Number);
		const count = daysInMonth(y, m);
		const byDate = new Map<string, Entry[]>();
		for (const e of app.monthEntries(month)) {
			const d = fmtDate(e.startTs);
			(byDate.get(d) ?? byDate.set(d, []).get(d)!).push(e);
		}
		const list = [];
		for (let d = 1; d <= count; d++) {
			const date = `${month}-${String(d).padStart(2, "0")}`;
			const wd = weekdayOfDate(date);
			const entries = (byDate.get(date) ?? []).sort((a, b) => a.startTs - b.startTs);
			// Projektzeit und Abwesenheit getrennt: die Pause geht nur von der
			// gearbeiteten Zeit ab, nie von einem Urlaubstag.
			let worked = 0;
			let absent = 0;
			for (const e of entries) {
				const isAbs = app.isAbsenceId(e.activityId);
				const h = entryHours(e, isAbs, app.settings.hoursPerDay, app.now);
				if (isAbs) absent += h;
				else worked += h;
			}
			const pause = app.settings.breakDeduction ? breakDeduction(worked) : 0;
			const hours = worked - pause + absent;
			// Abweichung laut Zeitwächter, in beide Richtungen. Tage, an denen in LOGA
			// nur „Kommen" steht, bleiben stumm – dort fehlt der Feierabend, nicht die
			// Zeit (Status „open", siehe reconcile).
			const rd = reportByDate.get(date);
			const missing = rd && (rd.status === "missing" || rd.status === "partial") ? rd.diff : 0;
			const over = rd?.status === "over" ? -rd.diff : 0;
			list.push({
				d,
				date,
				weekday: WEEKDAYS[wd],
				nonWorkday: !app.settings.workdays.includes(wd),
				entries,
				hours,
				pause,
				reportHours: rd?.report.hours ?? 0,
				missing,
				over
			});
		}
		return list;
	});

	const totalHours = $derived(days.reduce((s, day) => s + day.hours, 0));
	const todayStr = $derived(fmtDate(app.now));

	function openAdd(date?: string) {
		draft = emptyDraft(); // date = heute
		if (date) draft.date = date;
		spanNote = null;
		recalcDur();
		syncTimeText();
		dialogOpen = true;
	}

	/**
	 * Endzeitpunkt, den der Dialog aus Datum + Von/Bis wieder herstellen würde –
	 * dieselbe Folgetag-Regel wie in save(). Weicht er vom gespeicherten Ende ab,
	 * zeigt der Dialog etwas anderes an, als in der Datei steht.
	 */
	function reprEnd(e: Entry): number {
		const day = fmtDate(e.startTs);
		const clock = fmtClock(e.endTs!);
		const same = toTs(day, clock);
		return same < e.startTs ? toTs(fmtDate(startOfNextDay(e.startTs)), clock) : same;
	}

	/** Zeitstempel auf volle Minuten – fmtClock kennt keine Sekunden. */
	const toMin = (ts: number) => Math.floor(ts / 60000);

	function openEdit(e: Entry) {
		const end = e.endTs ?? Date.now();
		spanNote =
			e.endTs !== null && !app.isAbsenceId(e.activityId) && toMin(reprEnd(e)) !== toMin(e.endTs)
				? `Gespeichert ist ${fmtDateHuman(e.startTs)} ${fmtClock(e.startTs)} bis ${fmtDateHuman(e.endTs)} ${fmtClock(e.endTs)} – ${fmtHoursClock((e.endTs - e.startTs) / 3600000)} h. Speichern kürzt den Eintrag auf die Zeiten unten.`
				: null;
		draft = {
			id: e.id,
			originalStartTs: e.startTs,
			originalEndTs: e.endTs,
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

	async function save() {
		// Die Combobox hält draft.activityId stets auf einen gültigen Treffer (oder "").
		const activityId = draft.activityId;
		if (!activityId) {
			toast.error("Bitte eine bestehende Aktivität auswählen.");
			return;
		}
		const absence = app.isAbsenceId(activityId);
		if (!absence) {
			commitStart();
			commitEnd();
		}
		let startTs: number;
		let endTs: number;
		if (absence) {
			startTs = noonTs(draft.date);
			endTs = startTs;
		} else {
			startTs = toTs(draft.date, draft.start);
			endTs = toTs(draft.date, draft.end);
			// Bis vor Von -> Folgetag. startOfNextDay statt +24 h: an DST-Tagen hat
			// ein Tag 23 oder 25 Stunden.
			if (endTs < startTs) endTs = toTs(fmtDate(startOfNextDay(startTs)), draft.end);
			// Unangetastete Felder duerfen ihre Sekunden behalten – sonst ruecken sie
			// auf :00 und stossen in den Nachbar-Eintrag (siehe `keepSeconds`).
			if (draft.id) {
				startTs = keepSeconds(startTs, draft.originalStartTs);
				endTs = keepSeconds(endTs, draft.originalEndTs);
			}
		}
		if (Number.isNaN(startTs) || Number.isNaN(endTs)) return;
		// Von == Bis waere ein 0-Stunden-Eintrag: erfasst nichts, steht aber im Weg.
		if (!absence && endTs <= startTs) {
			toast.error("Bis muss nach Von liegen.");
			return;
		}

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
				absence ? draft.fraction : undefined,
				{ confirmAbsenceOverride: true }
			);
			// Konflikt (z.B. Ganztags-Abwesenheit) -> addEntry hat null + Toast geliefert.
			if (!created) return;
		}
		dialogOpen = false;
		// Auf den Monat des gespeicherten Eintrags springen, damit er sichtbar ist.
		month = draft.date.slice(0, 7);
	}

	/** Nach Speichern aus einem Unterdialog: ggf. auf dessen Monat springen + neu laden. */
	function afterExternalSave(m?: string) {
		if (m) month = m;
	}

	function entryLabel(e: Entry): string {
		const name = app.activityName(e.activityId);
		if (app.isAbsenceId(e.activityId)) {
			return `${name} · ${(e.dayFraction ?? 1) === 0.5 ? "½ Tag" : "ganzer Tag"}`;
		}
		const h = entryHours(e, false, app.settings.hoursPerDay, app.now);
		// Reicht der Eintrag über seinen Tag hinaus (vergessener Timer), gehört der
		// Endtag dazu – sonst stünde da "09:00–10:00" neben 73 Stunden.
		const bis = e.endTs
			? fmtClock(e.endTs) + (e.endTs > startOfNextDay(e.startTs) ? ` am ${fmtDateHuman(e.endTs)}` : "")
			: "…";
		return `${name} · ${fmtClock(e.startTs)}–${bis} (${fmtHoursClock(h)} h)`;
	}
</script>

<div class="space-y-4">
	{#if !anyPreview}
	<div class="flex flex-wrap items-end justify-between gap-3">
		<MonthSelector bind:month id="month" />
		<div class="flex flex-wrap items-center gap-3">
			<span class="text-muted-foreground text-sm">Σ {fmtHoursClock(totalHours)} h</span>
			<Button variant="outline" onclick={() => (vacOpen = true)}>
				<PalmtreeIcon class="size-4" /> Abwesenheit
			</Button>
			<Button variant="outline" onclick={() => (bulkOpen = true)}>
				<CalendarDaysIcon class="size-4" /> Mehrere Tage
			</Button>
			<Button onclick={() => openAdd()}><PlusIcon class="size-4" /> Eintrag</Button>
		</div>
	</div>

	<Card.Root>
		<Card.Content class="p-0">
			<!-- Kein divide-y: die Linie UNTER einer Zeile waere der border-top der
			     naechsten, damit liesse sie sich fuer heute nicht abschalten. Mit
			     eigenem border-b je Zeile geht das. -->
			<ul class="max-h-[calc(100vh-20rem)] overflow-y-auto">
				{#each days as day, i (day.date)}
					{@const isToday = day.date === todayStr}
					<!-- Heute traegt nur den linken Balken: die Zeilen konkurrieren schon mit
					     Amber (Abwesenheit) und bg-muted (freier Tag). Die Trennlinien ober-
					     und unterhalb entfallen, damit der Block zusammenhaengt – deshalb auch
					     border-b weg an der Zeile DAVOR. Alle Zeilen tragen den linken Balken
					     transparent, sonst versetzte heute den Inhalt um 2px. -->
					<li
						id={`day-row-${day.date}`}
						class="flex items-start gap-3 border-b border-l-2 px-3 py-1.5 text-sm last:border-b-0 {isToday ||
						days[i + 1]?.date === todayStr
							? 'border-b-transparent'
							: 'border-b-border'} {isToday
							? 'border-l-primary bg-primary/10'
							: day.nonWorkday
								? 'border-l-transparent bg-muted/60'
								: 'border-l-transparent'}"
					>
						<div class="w-14 shrink-0 pt-1">
							<div
								class="font-mono tabular-nums {day.date === todayStr
									? 'text-primary font-bold'
									: ''}"
							>
								{String(day.d).padStart(2, "0")}
							</div>
							<div class="text-muted-foreground text-xs">
								{day.weekday}{day.date === todayStr ? " · heute" : ""}
							</div>
						</div>
						<div class="flex-1 space-y-1 py-0.5">
							{#each day.entries as e (e.id)}
								{@const isAbs = app.isAbsenceId(e.activityId)}
								<!-- Button-Komponente statt roher <button>: bringt Fokusring, Hover
								     und Zeiger aus dem Design-System mit. `text-sm` überschreibt das
								     `text-xs` der xs-Größe, sonst schrumpfte die Eintragszeile. -->
								<div class="group flex items-center gap-1">
									<Button
										variant="ghost"
										size="xs"
										class="min-w-0 flex-1 justify-start text-sm font-normal {isAbs
											? 'bg-amber-500/15 text-amber-700 hover:bg-amber-500/25 hover:text-amber-700 dark:text-amber-300 dark:hover:text-amber-300'
											: ''}"
										onclick={() => openEdit(e)}
										title="Bearbeiten"
									>
										{#if isAbs}<PalmtreeIcon />{/if}
										<span class="truncate">{entryLabel(e)}</span>
									</Button>
									<Button
										variant="ghost"
										size="icon-xs"
										class="text-muted-foreground hover:text-destructive shrink-0"
										onclick={() => app.deleteEntry(e)}
										title="Löschen"
									>
										<Trash2Icon />
									</Button>
								</div>
							{/each}
						</div>
						<div class="flex items-center gap-2 pt-0.5">
							{#if day.missing > 0}
								<!-- Aus dem Zeitwirtschaftsreport: hier fehlt Zeit gegenueber LOGA. -->
								<span
									class="rounded bg-amber-500/15 px-1.5 py-0.5 font-mono text-xs tabular-nums text-amber-700 dark:text-amber-300"
									title={`LOGA: ${fmtHoursClock(day.reportHours)} h – hier fehlen ${fmtHoursClock(day.missing)} h`}
								>
									−{fmtHoursClock(day.missing)}
								</span>
							{:else if day.over > 0}
								<!-- Die Gegenrichtung: hier steht mehr, als LOGA fuer den Tag kennt.
								     Gleiches Blau wie „zu viel" im Abgleich, damit beide Ansichten
								     dieselbe Farbe fuer dieselbe Aussage benutzen. -->
								<span
									class="rounded bg-sky-500/15 px-1.5 py-0.5 font-mono text-xs tabular-nums text-sky-700 dark:text-sky-300"
									title={`LOGA: ${fmtHoursClock(day.reportHours)} h – hier sind ${fmtHoursClock(day.over)} h zu viel erfasst`}
								>
									+{fmtHoursClock(day.over)}
								</span>
							{/if}
							{#if day.pause > 0}
								<!-- Der Abzug muss sichtbar sein: die Tagessumme daneben ist sonst
								     unerklaerlich niedriger als die Eintraege darueber. -->
								<span
									class="text-muted-foreground text-xs"
									title={`${fmtHoursClock(day.pause)} h Pause automatisch abgezogen`}
								>
									−{fmtHoursClock(day.pause)}&nbsp;Pause
								</span>
							{/if}
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
	{/if}

	<!-- Nebeneinander, damit beide Wege sichtbar sind: untereinander rutschte der
	     zweite unter den Fensterrand und war praktisch nicht auffindbar.
	     Uebernimmt eine Karte die Ansicht, weicht die andere und die verbleibende
	     bekommt die volle Breite. -->
	<!-- Gleiche Hoehe fuer beide Karten (kein items-start): unterschiedlich hohe
	     Nachbarn sahen unfertig aus. Die kuerzere Karte setzt ihre Aktion dafuer
	     ans untere Ende, statt Leerraum zu hinterlassen. -->
	<div class="grid gap-4 {anyPreview ? '' : 'md:grid-cols-2'}">
		{#if !reportPreview}
			<CalendarImport {month} bind:previewActive={importPreview} />
		{/if}
		{#if !importPreview}
			<TimeReportImport bind:month bind:previewActive={reportPreview} />
		{/if}
	</div>
</div>

<BulkEntryDialog bind:open={bulkOpen} onsaved={afterExternalSave} />

<VacationRange bind:open={vacOpen} onsaved={afterExternalSave} />

<Dialog.Root bind:open={dialogOpen}>
	<!-- Beim BEARBEITEN nicht automatisch in die Aktivitäts-Combobox springen: sie
	     klappt bei Fokus ihre Liste auf und legt sich über die Felder, die man
	     eigentlich ändern wollte. Beim NEUEN Eintrag ist genau das erwünscht – dort
	     fehlt die Aktivität noch. Der Fokus wandert stattdessen auf den Dialog
	     selbst, damit er im Modal bleibt (Tab/Escape). -->
	<Dialog.Content
		bind:ref={dialogEl}
		class="sm:max-w-md"
		onOpenAutoFocus={(e) => {
			if (draft.id === null) return;
			e.preventDefault();
			dialogEl?.focus();
		}}
	>
		<form class="grid gap-4" onsubmit={(e) => { e.preventDefault(); save(); }}>
			<Dialog.Header>
				<Dialog.Title>{draft.id ? "Eintrag bearbeiten" : "Neuer Eintrag"}</Dialog.Title>
			</Dialog.Header>
			<div class="space-y-3">
			{#if spanNote}
				<p
					class="rounded-md bg-amber-500/15 px-2.5 py-2 text-xs text-amber-700 dark:text-amber-300"
				>
					{spanNote}
				</p>
			{/if}
			<div class="space-y-1">
				<Label for="act">Aktivität</Label>
				<ActivityCombobox id="act" bind:value={draft.activityId} options={activityOptions} />
			</div>

			{#if draftIsAbsence}
				<div class="grid grid-cols-2 gap-2">
					<div class="space-y-1">
						<Label for="date">Datum</Label>
						<DateInput id="date" bind:value={draft.date} />
					</div>
					<DayFractionSwitch id="frac" bind:value={draft.fraction} />
				</div>
			{:else}
				<div class="grid grid-cols-3 gap-2">
					<div class="col-span-3 space-y-1">
						<Label for="date">Datum</Label>
						<DateInput id="date" bind:value={draft.date} />
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
				{#if splitHint}
					<p class="text-muted-foreground text-xs">{splitHint}</p>
				{/if}

				{#if dayAdjust}
					<!-- Aus dem Zeitwirtschaftsreport: der Tag weicht von LOGA ab. Der Knopf
					     setzt die Dauer DIESES Eintrags so, dass der Tag hinkommt – „Von"
					     bleibt stehen, „Bis" wandert. Gespeichert wird dabei nichts: die
					     Zeiten stehen danach im Formular und lassen sich noch anfassen. -->
					<div
						class="flex flex-wrap items-center justify-between gap-2 rounded-md px-2.5 py-2 text-xs {dayAdjust.delta >
						0
							? 'bg-amber-500/15 text-amber-700 dark:text-amber-300'
							: dayAdjust.delta < 0
								? 'bg-sky-500/15 text-sky-700 dark:text-sky-300'
								: 'bg-muted text-muted-foreground'}"
					>
						<span class="min-w-0 flex-1">
							{#if dayAdjust.delta > 0}
								Zeitwächter: an diesem Tag fehlen {fmtHoursClock(dayAdjust.delta)} h – LOGA kennt
								{fmtHoursClock(dayAdjust.reportHours)} h.
							{:else if dayAdjust.delta < 0}
								Zeitwächter: an diesem Tag sind {fmtHoursClock(-dayAdjust.delta)} h zu viel erfasst –
								LOGA kennt {fmtHoursClock(dayAdjust.reportHours)} h.
							{:else}
								Passt zum Zeitwächter: der Tag kommt damit auf {fmtHoursClock(
									dayAdjust.reportHours
								)} h.
							{/if}
							{#if dayAdjust.delta !== 0 && !dayAdjust.block}
								Über diesen Eintrag allein geht das nicht.
							{/if}
						</span>
						{#if dayAdjust.block}
							<Button type="button" variant="outline" size="xs" onclick={applyDayAdjust}>
								{dayAdjust.delta > 0
									? `${fmtHoursClock(dayAdjust.delta)} h ergänzen`
									: `${fmtHoursClock(-dayAdjust.delta)} h abziehen`}
							</Button>
						{/if}
					</div>
				{/if}
			{/if}

			</div>
			<Dialog.Footer>
				<Button type="button" variant="outline" onclick={() => (dialogOpen = false)}>Abbrechen</Button>
				<Button type="submit">Speichern</Button>
			</Dialog.Footer>
		</form>
	</Dialog.Content>
</Dialog.Root>
