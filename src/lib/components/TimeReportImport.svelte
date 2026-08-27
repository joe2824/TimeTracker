<script lang="ts">
	import { app } from "$lib/app.svelte";
	import { toast } from "svelte-sonner";
	import { readXlsx, XlsxError } from "$lib/xlsx";
	import {
		parseTimeReport,
		TimeReportError,
		breakHours,
		grossHours,
		hasStamps,
		ruleBreakHours,
		type ParsedTimeReport,
		type TimeReportPerson
	} from "$lib/timeReport";
	import {
		DEFAULT_FILL_OPTIONS,
		distributeDays,
		planFill,
		reconcile,
		splitBlocks,
		type FillPlan,
		type ReconcileDay,
		type Interval,
		type ReconcileStatus,
		type Share,
		type SplitMode
	} from "$lib/timeReconcile";
	import {
		listTimeReportMonths,
		loadTimeReport,
		saveTimeReport,
		type StoredTimeReport
	} from "$lib/store";
	import { BUILTIN_OTHERS } from "$lib/types";
	import { errorText, logError, logInfo } from "$lib/log";
	import {
		fmtDateHuman,
		fmtHoursClock,
		minToClock,
		monthLabel,
		noonTs,
		startOfNextDay,
		toTs
	} from "$lib/time";
	import { Button } from "$lib/components/ui/button";
	import { Badge } from "$lib/components/ui/badge";
	import { Checkbox } from "$lib/components/ui/checkbox";
	import { Progress } from "$lib/components/ui/progress";
	import * as Alert from "$lib/components/ui/alert";
	import * as ButtonGroup from "$lib/components/ui/button-group";
	import * as Card from "$lib/components/ui/card";
	import * as Select from "$lib/components/ui/select";
	import * as Table from "$lib/components/ui/table";
	import ActivityCombobox from "$lib/components/ActivityCombobox.svelte";
	import ProjectSplit from "$lib/components/ProjectSplit.svelte";
	import * as Tooltip from "$lib/components/ui/tooltip";
	import FileSpreadsheetIcon from "@lucide/svelte/icons/file-spreadsheet";
	import UploadIcon from "@lucide/svelte/icons/upload";
	import LoaderCircleIcon from "@lucide/svelte/icons/loader-circle";
	import PalmtreeIcon from "@lucide/svelte/icons/palmtree";
	import TriangleAlertIcon from "@lucide/svelte/icons/triangle-alert";
	import CheckIcon from "@lucide/svelte/icons/check";
	import ChevronLeftIcon from "@lucide/svelte/icons/chevron-left";
	import ChevronRightIcon from "@lucide/svelte/icons/chevron-right";
	import SplitIcon from "@lucide/svelte/icons/split";
	import XIcon from "@lucide/svelte/icons/x";

	let {
		month = $bindable(),
		previewActive = $bindable(false)
	}: { month: string; previewActive?: boolean } = $props();

	/** Ab welcher Abweichung ein Tag auffaellt (Stunden). 15 Minuten. */
	const TOLERANCE = 0.25;
	/** Notiz der nachgetragenen Eintraege – macht sie in der Tagesliste erkennbar. */
	const NOTE = "Zeitwächter";

	let stage = $state<"idle" | "loading" | "review">("idle");
	let dragOver = $state(false);
	let applying = $state(false);
	let fileInput = $state<HTMLInputElement | null>(null);

	/** Die eingelesene Datei, solange die Auswahl von Person/Monat laeuft. */
	let parsed = $state<ParsedTimeReport | null>(null);
	let personKey = $state("");
	/** Der Report, gegen den gerade abgeglichen wird (aus Datei oder von Platte). */
	let active = $state<StoredTimeReport | null>(null);
	/** Der auf Platte liegende Report des aktuellen Monats (fuer den Ruhezustand). */
	let stored = $state<StoredTimeReport | null>(null);
	/** Alle Monate, zu denen ein Report auf der Platte liegt. */
	let reportMonths = $state<string[]>([]);

	async function refreshReportMonths() {
		try {
			reportMonths = await listTimeReportMonths();
		} catch {
			// Nicht schlimm: dann steht in der Auswahl nur der offene Monat.
		}
	}
	void refreshReportMonths();

	/** Auswahl und Zuordnung je Tag, Schluessel = Datum. */
	let selected = $state<Record<string, boolean>>({});
	let activityFor = $state<Record<string, string>>({});
	/** Zuordnung der Stunden JENSEITS der Stempelzeiten, Schluessel = Datum. */
	let extraActivityFor = $state<Record<string, string>>({});
	/** Tage, die auf MEHRERE Projekte aufgeteilt werden, Schluessel = Datum. */
	let splitFor = $state<Record<string, Share[]>>({});
	/** Der Verteilen-Bereich ist zugeklappt, bis jemand ihn braucht. */
	let splitOpen = $state(false);
	/** „Alle Tage auf …" – wirkt beim Wechsel auf alle Zeilen mit Uhrzeiten. */
	let bulkActivity = $state("");
	let lastBulk = "";

	$effect(() => {
		const id = bulkActivity;
		if (!id || id === lastBulk) return;
		lastBulk = id;
		setAllActivities(id);
	});

	$effect(() => {
		previewActive = stage !== "idle";
	});

	// Im Ruhezustand zeigen, ob fuer diesen Monat schon ein Report vorliegt.
	$effect(() => {
		const m = month;
		if (stage !== "idle") return;
		void loadTimeReport(m)
			.then((r) => {
				if (month === m) stored = r;
			})
			.catch(() => {});
	});

	// ---------- Abgleich ----------

	const absenceId = $derived(app.absenceActivity?.id ?? "");
	const absenceIds = $derived(new Set(app.activities.filter((a) => a.isAbsence).map((a) => a.id)));

	function summarize(report: StoredTimeReport) {
		return reconcile(report.days, app.monthEntries(report.month), {
			hoursPerDay: app.settings.hoursPerDay,
			tolerance: TOLERANCE,
			absenceIds,
			now: app.now,
			deductBreaks: app.settings.breakDeduction
		});
	}

	const summary = $derived(active ? summarize(active) : null);

	// Ohne die geladenen Eintraege waere jeder Tag „fehlt".
	$effect(() => {
		if (stored) void app.ensureMonth(stored.month).catch(() => {});
	});

	/** Bilanz des gespeicherten Reports fuer die Ruhe-Ansicht der Karte. */
	const storedSummary = $derived(
		stage === "idle" && stored && app.entriesByMonth[stored.month] ? summarize(stored) : null
	);

	/** Nur die Tage, zu denen es etwas zu sagen gibt – freie Tage bleiben draussen. */
	const rows = $derived.by(() => {
		if (!summary) return [];
		const entries = app.monthEntries(active!.month);
		return summary.days
			.filter((d) => d.status !== "free")
			.map((day) => ({
				day,
				plan: planFill(day, entries, {
					...DEFAULT_FILL_OPTIONS,
					deductBreaks: app.settings.breakDeduction
				})
			}));
	});

	/** Die Person, um die es gerade geht – nur bekannt, wenn eine Datei offen ist. */
	const activePerson = $derived(parsed?.people.find((p) => p.key === active?.personKey) ?? null);
	/**
	 * Monate, die sich hier direkt aufrufen lassen: die DIESER Person aus der
	 * offenen Datei plus alles, was schon eingelesen auf der Platte liegt.
	 */
	const availableMonths = $derived.by(() => {
		const set = new Set(reportMonths);
		if (activePerson) for (const m of monthsOf(activePerson)) set.add(m);
		if (active) set.add(active.month);
		return [...set].sort();
	});

	function monthsOf(person: TimeReportPerson): string[] {
		return [...new Set(person.days.map((d) => d.date.slice(0, 7)))].sort();
	}

	const fixable = $derived(rows.filter((r) => r.plan !== null && !r.day.alreadyFilled));
	const picked = $derived(fixable.filter((r) => selected[r.day.date]));
	/** Angehakt UND zuordenbar. */
	const chosen = $derived(
		picked.filter(
			(r) =>
				r.plan?.kind === "absence" ||
				!!activityFor[r.day.date] ||
				(splitFor[r.day.date]?.length ?? 0) > 0
		)
	);
	/** Angehakt, aber noch ohne Projekt – die Zahl gehoert sichtbar neben den Knopf. */
	const unassigned = $derived(picked.length - chosen.length);
	/** Wie viel der Monat schon abgedeckt ist – 100 % heisst „nichts offen". */
	const coverage = $derived.by(() => {
		if (!summary) return 100;
		const relevant = summary.days.filter((d) => d.report.hours > 0).length;
		if (relevant === 0) return 100;
		return Math.round(((relevant - summary.missing - summary.partial) / relevant) * 100);
	});

	/** Vorschlag fuer die ungestempelten Stunden: die eingebaute Zeile „Others". */
	function othersActivity(): string {
		return app.trackableActivities.find((a) => a.name === BUILTIN_OTHERS)?.id ?? "";
	}

	/** Auswahl und Aktivitaeten fuer den aktuellen Abgleich neu setzen. */
	function resetSelection() {
		const others = othersActivity();
		const sel: Record<string, boolean> = {};
		const acts: Record<string, string> = {};
		const extra: Record<string, string> = {};
		for (const { day, plan } of rows) {
			// Schon Nachgetragenes nicht erneut anhaken – sonst entstuenden Dubletten.
			sel[day.date] = plan !== null && !day.alreadyFilled;
			// Bewusst leer: ein vorbelegter Vorschlag träfe oft das falsche Projekt,
			// unbemerkt beim Durchklicken. „Alle Tage auf …" deckt den Sammelfall ab.
			acts[day.date] = "";
			extra[day.date] = others;
		}
		selected = sel;
		activityFor = acts;
		extraActivityFor = extra;
		splitFor = {};
		bulkActivity = "";
		lastBulk = "";
	}

	function setAllActivities(id: string) {
		for (const { day, plan } of rows) {
			if (plan?.kind !== "time") continue;
			activityFor[day.date] = id;
			// „Alle Tage auf X" heisst genau ein Projekt – eine fruehere Verteilung
			// stuende sonst still daneben und gaebe beim Uebernehmen den Ton an.
			delete splitFor[day.date];
		}
	}

	/** Die ausgewaehlten Tage mit Zeitnachtrag – nur die lassen sich verteilen. */
	const splittable = $derived(
		picked.filter((r) => r.plan?.kind === "time" && r.plan.blocks.length > 0)
	);
	const splittableHours = $derived(splittable.reduce((s, r) => s + (r.plan?.hours ?? 0), 0));

	/** Die Anteile auf die ausgewaehlten Tage legen. */
	function applySplit(shares: Share[], mode: SplitMode) {
		if (shares.length === 0 || splittable.length === 0) return;
		if (mode === "days") {
			const map = distributeDays(
				splittable.map((r) => ({ date: r.day.date, hours: r.plan!.hours })),
				shares
			);
			for (const r of splittable) {
				if (!map[r.day.date]) continue;
				activityFor[r.day.date] = map[r.day.date];
				delete splitFor[r.day.date];
			}
		} else {
			for (const r of splittable) {
				splitFor[r.day.date] = shares;
				// Die Einzelauswahl der Zeile hat jetzt nichts mehr zu sagen.
				activityFor[r.day.date] = "";
			}
		}
		// „Alle Tage auf …" muss danach wieder greifen, auch mit derselben Auswahl:
		// der Wechsel-Effekt vergleicht mit dem zuletzt gesetzten Wert.
		bulkActivity = "";
		lastBulk = "";
		// Der Bereich bleibt offen: nach dem ersten Blick auf das Ergebnis will man
		// das Verhältnis meist noch einmal nachziehen, und dafür müssten sonst alle
		// Projekte und Prozente neu eingegeben werden.
		toast.success(
			`Verteilt auf ${splittable.length} Tag${splittable.length === 1 ? "" : "e"}${
				mode === "days" ? " (tageweise)" : ""
			}.`
		);
	}

	/** Einen Tag aus der Verteilung nehmen und wieder einzeln zuordnen. */
	function clearSplit(date: string) {
		delete splitFor[date];
	}

	function toggleAll(on: boolean) {
		for (const r of fixable) selected[r.day.date] = on;
	}

	// ---------- Datei einlesen ----------

	async function handleFile(file: File) {
		stage = "loading";
		try {
			const report = parseTimeReport(await readXlsx(await file.arrayBuffer()));
			parsed = report;
			// Bei genau einer Person gibt es nichts zu waehlen.
			personKey = report.people.length === 1 ? report.people[0].key : (matchOwnPerson(report) ?? "");
			logInfo("Zeitwirtschaftsreport eingelesen", {
				datei: file.name,
				personen: report.people.length,
				monate: report.months
			});
			const person = report.people.find((p) => p.key === personKey);
			if (person) await useReport(person.key, preferredMonth(person));
			else stage = "review";
		} catch (e) {
			stage = "idle";
			parsed = null;
			if (e instanceof XlsxError || e instanceof TimeReportError) toast.error(e.message);
			else {
				logError("Zeitwirtschaftsreport konnte nicht gelesen werden", e);
				toast.error(`Datei konnte nicht gelesen werden: ${errorText(e)}`);
			}
		}
	}

	/**
	 * Der Monat, mit dem der Abgleich startet: der aus der Einträge-Ansicht, wenn
	 * die Datei ihn enthaelt, sonst der letzte darin.
	 */
	function preferredMonth(person: TimeReportPerson): string {
		const months = monthsOf(person);
		if (months.length === 0) return month;
		return months.includes(month) ? month : months[months.length - 1];
	}

	/**
	 * Die eigene Person in einem Team-Export raten: ueber den Absendernamen aus
	 * den Einstellungen. Trifft es nicht, wird gefragt.
	 */
	function matchOwnPerson(report: ParsedTimeReport): string | null {
		const own = app.settings.senderName.trim().toLowerCase();
		if (!own) return null;
		const hit = report.people.find((p) => p.name.toLowerCase() === own);
		return hit?.key ?? null;
	}

	/** Person + Monat festlegen, speichern und in den Abgleich wechseln. */
	async function useReport(key: string, targetMonth: string) {
		const person = parsed?.people.find((p) => p.key === key);
		if (!person) return;
		const days = person.days.filter((d) => d.date.startsWith(`${targetMonth}-`));
		// Nichts speichern, was nichts enthaelt: ein leerer Monat wuerde einen
		// frueher eingelesenen Report desselben Monats ueberschreiben, und der
		// Abgleich zeigte danach eine leere Tabelle ohne erkennbaren Grund.
		if (days.length === 0) {
			toast.error(`Für ${monthLabel(targetMonth)} enthält die Datei keine Tage von ${person.name}.`);
			return;
		}
		// Ohne das bliebe bei einem Team-Export die Personenauswahl stehen und der
		// Klick sähe aus, als passiere nichts.
		personKey = person.key;
		const report: StoredTimeReport = {
			month: targetMonth,
			importedAt: Date.now(),
			personKey: person.key,
			personName: person.name,
			days
		};
		month = targetMonth;
		await app.ensureMonth(targetMonth);
		try {
			await saveTimeReport(report);
		} catch (e) {
			// Der Abgleich geht auch ohne gespeicherte Datei – nur nicht nach einem Neustart.
			logError("Zeitwirtschaftsreport konnte nicht gespeichert werden", e);
			toast.warning("Der Report wurde eingelesen, aber nicht gespeichert.");
		}
		active = report;
		stored = report;
		stage = "review";
		void refreshReportMonths();
		resetSelection();
	}

	/**
	 * Im Abgleich den Monat wechseln – aus der offenen Datei, wenn sie ihn kennt,
	 * sonst aus dem gespeicherten Report.
	 */
	async function switchMonth(target: string) {
		if (!target || target === active?.month) return;
		if (activePerson && monthsOf(activePerson).includes(target)) {
			await useReport(activePerson.key, target);
			return;
		}
		const report = await loadTimeReport(target).catch(() => null);
		if (!report) {
			toast.error(`Für ${monthLabel(target)} liegt kein eingelesener Report vor.`);
			return;
		}
		month = target;
		await app.ensureMonth(target);
		// `parsed` bleibt stehen: sonst verschwaenden die uebrigen Monate der noch
		// offenen Datei aus der Auswahl und waeren nur ueber einen neuen Import
		// wieder zu erreichen. Stammt der gespeicherte Report von jemand anderem,
		// faellt `activePerson` von selbst weg – es haengt an `active.personKey`.
		personKey = report.personKey;
		active = report;
		stored = report;
		resetSelection();
	}

	/** Den gespeicherten Report dieses Monats wieder oeffnen. */
	async function openStored() {
		if (!stored) return;
		await app.ensureMonth(stored.month);
		parsed = null;
		active = stored;
		stage = "review";
		resetSelection();
	}

	function pickFile(e: Event) {
		const file = (e.currentTarget as HTMLInputElement).files?.[0];
		if (file) void handleFile(file);
		// Zuruecksetzen, damit dieselbe Datei erneut gewaehlt werden kann.
		(e.currentTarget as HTMLInputElement).value = "";
	}

	function onDrop(e: DragEvent) {
		e.preventDefault();
		dragOver = false;
		const file = e.dataTransfer?.files?.[0];
		if (!file) return;
		if (!file.name.toLowerCase().endsWith(".xlsx")) {
			toast.error("Bitte die .xlsx aus Scout ablegen.");
			return;
		}
		void handleFile(file);
	}

	function close() {
		if (applying) return;
		stage = "idle";
		parsed = null;
		active = null;
	}

	// ---------- Uebernehmen ----------

	/** Zeitstempel fuer „Minute X dieses Tages"; 1440 ist Mitternacht des Folgetags. */
	function tsAt(date: string, minutes: number): number {
		if (minutes >= 1440) return startOfNextDay(noonTs(date));
		return toTs(date, minToClock(minutes));
	}

	async function apply() {
		if (applying || chosen.length === 0) return;
		applying = true;
		let days = 0;
		let created = 0;
		let failed = 0;
		try {
			for (const { day, plan } of chosen) {
				if (!plan) continue;
				let any = false;
				if (plan.kind === "absence") {
					if (!absenceId) {
						failed++;
						continue;
					}
					const ts = noonTs(day.date);
					any = !!(await app.addEntry(absenceId, ts, ts, NOTE, "loga", plan.fraction));
				} else {
					const split = splitFor[day.date] ?? [];
					const activityId = activityFor[day.date];
					if (!activityId && split.length === 0) {
						failed++;
						continue;
					}
					// Gestempelte Zeit und die Stunden jenseits davon koennen auf
					// verschiedene Aktivitaeten gehen; die gestempelte Zeit selbst
					// zusaetzlich auf mehrere, wenn der Tag verteilt wurde.
					const inside =
						split.length > 0
							? splitBlocks(plan.blocks, split)
							: [{ id: activityId, blocks: plan.blocks }];
					const parts: { blocks: typeof plan.blocks; id: string }[] = [
						...inside,
						{
							blocks: plan.extraBlocks,
							// Ohne eigene Wahl auf das erste Projekt des Tages – bei einer
							// Verteilung gibt es keine „eine" Aktivitaet mehr.
							id: extraActivityFor[day.date] || activityId || inside[0]?.id || ""
						}
					];
					for (const part of parts) {
						if (!part.id) continue;
						for (const block of part.blocks) {
							const e = await app.addEntry(
								part.id,
								tsAt(day.date, block.start),
								tsAt(day.date, block.end),
								NOTE,
								"loga"
							);
							if (e) {
								created++;
								any = true;
							}
						}
					}
				}
				if (any) days++;
				else failed++;
			}
		} catch (e) {
			// Mittendrin gescheitert: das bereits Angelegte steht auf der Platte.
			// Was schon durch ist, wird unten trotzdem gemeldet.
			logError("Nachtragen aus dem Zeitwirtschaftsreport abgebrochen", e);
			toast.error(`Nachtragen abgebrochen: ${errorText(e)}`);
		} finally {
			applying = false;
		}

		if (days > 0) {
			logInfo("Zeiten aus dem Zeitwirtschaftsreport nachgetragen", {
				monat: active?.month,
				tage: days,
				eintraege: created
			});
			toast.success(`${days} Tag${days === 1 ? "" : "e"} nachgetragen.`);
		}
		if (failed > 0) {
			toast.warning(
				`${failed} Tag${failed === 1 ? " konnte" : "e konnten"} nicht nachgetragen werden – bitte einzeln prüfen.`
			);
		}
		resetSelection();
	}

	// ---------- Darstellung ----------

	const STATUS: Record<ReconcileStatus, { label: string; class: string }> = {
		missing: { label: "fehlt", class: "bg-destructive/15 text-destructive" },
		partial: { label: "teilweise", class: "bg-amber-500/15 text-amber-700 dark:text-amber-300" },
		over: { label: "zu viel", class: "bg-sky-500/15 text-sky-700 dark:text-sky-300" },
		ok: { label: "stimmt", class: "text-muted-foreground" },
		free: { label: "frei", class: "text-muted-foreground" },
		open: { label: "offen", class: "text-muted-foreground" }
	};

	const FLAG_HINT: Record<string, string> = {
		ruhepause: "Die gesetzliche Ruhepause wurde an diesem Tag nicht eingehalten.",
		ueber10: "Die tägliche Arbeitszeit lag über 10 Stunden.",
		soll10: "Die Soll-Arbeitszeit liegt über 10 Stunden.",
		wiedereingliederung: "Tag im Rahmen einer Wiedereingliederung.",
		sonntag: "An diesem Sonntag wurde gearbeitet.",
		feiertag: "An diesem Feiertag wurde gearbeitet."
	};

	/** "Mo 12.01." – kurz genug fuer die Tabellenspalte. */
	function dayLabel(date: string): string {
		return new Date(noonTs(date)).toLocaleDateString("de-DE", {
			weekday: "short",
			day: "2-digit",
			month: "2-digit"
		});
	}

	/** Bloecke eines Vorschlags als Text: "08:00–12:00, 12:30–16:30". */
	function blockRanges(blocks: Interval[]): string {
		const end = (min: number) => (min === 1440 ? "24:00" : minToClock(min));
		return blocks.map((b) => `${minToClock(b.start)}–${end(b.end)}`).join(", ");
	}

	function planLabel(plan: FillPlan): string {
		if (plan.kind === "absence") return plan.fraction === 0.5 ? "½ Tag" : "ganzer Tag";
		return blockRanges(plan.blocks);
	}

	/**
	 * Bleibt an diesem Tag eine Differenz stehen, weil LOGA anders abgezogen hat
	 * als die Hausregel? Dann sind die Stempelzeiten voll erfasst und mehr geht
	 * nicht, ohne Anwesenheit zu erfinden.
	 */
	function ruleMismatch(day: ReconcileDay): boolean {
		if (!app.settings.breakDeduction || !hasStamps(day.report)) return false;
		const brutto = grossHours(day.report);
		return Math.abs(brutto - day.report.hours - ruleBreakHours(brutto)) > TOLERANCE;
	}

	function stampLabel(day: ReconcileDay): string {
		return hasStamps(day.report) ? `${day.report.firstIn}–${day.report.lastOut}` : "—";
	}
</script>

<!--
	Eine Datei, die NEBEN der Ablegefläche landet, würde die Webview sonst zur
	`file://`-Adresse navigieren und die App damit aus dem Fenster werfen – der
	laufende Timer inklusive. Das native Drag-Drop von Tauri ist abgeschaltet
	(`dragDropEnabled: false`), also muss die Seite das selbst abfangen.
-->
<svelte:window
	ondragover={(e) => e.preventDefault()}
	ondrop={(e) => e.preventDefault()}
/>

<input
	bind:this={fileInput}
	type="file"
	accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
	class="hidden"
	onchange={pickFile}
/>

<!-- overflow-visible im Abgleich: die Karte kappt sonst die Liste der
     Aktivitäts-Combobox in den unteren Tabellenzeilen. -->
<Card.Root class="h-full {stage === 'review' ? 'overflow-visible' : ''}">
	<Card.Header>
		<Card.Title class="flex items-center gap-2.5">
			<span
				class="bg-primary/10 text-primary flex size-8 shrink-0 items-center justify-center rounded-md"
			>
				<FileSpreadsheetIcon class="size-4" />
			</span>
			Zeitwächter-Report
		</Card.Title>
		<Card.Description>
			Den Zeitwirtschaftsreport aus Scout ablegen – die App zeigt, an welchen Tagen Zeit fehlt, und
			trägt sie auf Wunsch nach.
		</Card.Description>
		{#if stage === "review"}
			<Card.Action>
				<Button variant="outline" size="sm" onclick={close} disabled={applying}>Schließen</Button>
			</Card.Action>
		{/if}
	</Card.Header>

	{#if stage === "loading"}
		<Card.Content class="space-y-2">
			<div class="text-muted-foreground flex items-center gap-2 text-sm">
				<LoaderCircleIcon class="size-4 shrink-0 animate-spin" /> Datei wird gelesen…
			</div>
		</Card.Content>

	{:else if stage === "idle"}
		<!-- flex-1: die Ablegefläche wächst mit, wenn die Nachbarkarte die höhere
		     ist – sonst bliebe sie oben kleben und darunter stünde Leerraum. -->
		<Card.Content class="flex flex-1 flex-col gap-3">
			<!-- Ablegen UND Klicken auf demselben Element: ein <button> bringt Fokus
			     und Tastaturbedienung mit, ein <div> mit Drop-Handler haette beides nicht. -->
			<button
				type="button"
				onclick={() => fileInput?.click()}
				ondragover={(e) => {
					e.preventDefault();
					dragOver = true;
				}}
				ondragleave={() => (dragOver = false)}
				ondrop={onDrop}
				class="group focus-visible:ring-ring/50 flex w-full flex-1 cursor-pointer items-center justify-center gap-3 rounded-lg border-2 border-dashed px-5 py-4 text-left transition-colors focus-visible:ring-2 focus-visible:outline-none {dragOver
					? 'border-primary bg-primary/5'
					: 'border-border/70 hover:border-primary/40 hover:bg-muted/40'}"
			>
				<span
					class="flex size-9 shrink-0 items-center justify-center rounded-full transition-colors {dragOver
						? 'bg-primary/15 text-primary'
						: 'bg-muted text-muted-foreground group-hover:bg-primary/10 group-hover:text-primary'}"
				>
					<UploadIcon class="size-4" />
				</span>
				<!-- Spans statt divs: der Inhalt eines <button> darf nur Phrasing Content sein. -->
				<span class="min-w-0">
					<span class="block text-sm font-medium">Zeitwirtschaftsreport hier ablegen</span>
					<span class="text-muted-foreground block text-xs">
						.xlsx aus Scout · oder klicken, um eine Datei zu wählen
					</span>
				</span>
			</button>

			{#if stored}
				{@const offen = storedSummary ? storedSummary.missing + storedSummary.partial : 0}
				<!-- Der gespeicherte Report sagt hier gleich, ob noch etwas offen ist –
				     sonst müsste man den Abgleich öffnen, nur um „alles gut" zu sehen. -->
				<div class="flex items-center justify-between gap-3 rounded-lg border p-3">
					<div class="flex min-w-0 items-start gap-2.5">
						<span
							class="flex size-8 shrink-0 items-center justify-center rounded-md {offen > 0
								? 'bg-amber-500/15 text-amber-600 dark:text-amber-400'
								: 'bg-muted text-muted-foreground'}"
						>
							{#if offen > 0}
								<TriangleAlertIcon class="size-4" />
							{:else}
								<CheckIcon class="size-4" />
							{/if}
						</span>
						<div class="min-w-0">
							<p class="truncate text-sm font-medium">
								{monthLabel(stored.month)}
								{#if stored.personName}
									<span class="text-muted-foreground font-normal">· {stored.personName}</span>
								{/if}
							</p>
							<p class="text-muted-foreground truncate text-xs">
								{#if storedSummary && offen > 0}
									{offen} Tag{offen === 1 ? "" : "e"} offen · {fmtHoursClock(storedSummary.missingHours)} h
									fehlen ·
								{:else if storedSummary}
									alles erfasst ·
								{/if}
								eingelesen {fmtDateHuman(stored.importedAt)}
							</p>
						</div>
					</div>
					<Button variant={offen > 0 ? "default" : "outline"} size="sm" onclick={openStored}>
						Abgleich öffnen
					</Button>
				</div>
			{/if}
		</Card.Content>

	{:else if parsed && !personKey}
		<Card.Content class="space-y-3">
			<p class="text-sm">Die Datei enthält mehrere Personen. Wessen Zeiten sollen abgeglichen werden?</p>
			<div class="flex flex-wrap gap-2">
				{#each parsed.people as p (p.key)}
					<Button variant="outline" size="sm" onclick={() => useReport(p.key, preferredMonth(p))}>
						{p.name}
						{#if p.personnelNo}<span class="text-muted-foreground">· {p.personnelNo}</span>{/if}
					</Button>
				{/each}
			</div>
			<Button variant="ghost" size="sm" onclick={close}>Abbrechen</Button>
		</Card.Content>

	{:else if active && summary}
		<Card.Content class="space-y-3 p-0">
			<div class="space-y-3 px-6">
				<div class="flex flex-wrap items-center justify-between gap-3">
					<div class="flex flex-wrap items-center gap-2">
						{#if availableMonths.length > 1}
							{@const idx = availableMonths.indexOf(active.month)}
							<!-- Pfeile wie in der Monatsauswahl der Eintraege-Ansicht, hier aber
							     entlang der VORHANDENEN Monate: ein Schritt auf einen Monat ohne
							     Report brächte nur eine Fehlermeldung. Am Rand sind sie deshalb
							     abgeschaltet, statt ins Leere zu führen. -->
							<ButtonGroup.Root>
								<Button
									variant="outline"
									size="icon-sm"
									aria-label="Vorheriger Monat"
									title="Vorheriger Monat"
									disabled={idx <= 0}
									onclick={() => void switchMonth(availableMonths[idx - 1])}
								>
									<ChevronLeftIcon />
								</Button>
								<Select.Root
									type="single"
									value={active.month}
									onValueChange={(v) => v && switchMonth(v)}
								>
									<Select.Trigger size="sm" class="w-44">{monthLabel(active.month)}</Select.Trigger>
									<Select.Content>
										{#each availableMonths as m (m)}
											<Select.Item value={m} label={monthLabel(m)}>{monthLabel(m)}</Select.Item>
										{/each}
									</Select.Content>
								</Select.Root>
								<Button
									variant="outline"
									size="icon-sm"
									aria-label="Nächster Monat"
									title="Nächster Monat"
									disabled={idx < 0 || idx >= availableMonths.length - 1}
									onclick={() => void switchMonth(availableMonths[idx + 1])}
								>
									<ChevronRightIcon />
								</Button>
							</ButtonGroup.Root>
						{:else}
							<span class="font-medium">{monthLabel(active.month)}</span>
						{/if}
						{#if active.personName}
							<Badge variant="secondary">{active.personName}</Badge>
						{/if}
					</div>
					<div class="text-muted-foreground flex flex-wrap items-center gap-3 text-sm">
						<span>{summary.ok} stimmen</span>
						{#if summary.missing > 0}<span class="text-destructive">{summary.missing} fehlen</span>{/if}
						{#if summary.partial > 0}
							<span class="text-amber-700 dark:text-amber-300">{summary.partial} teilweise</span>
						{/if}
						{#if summary.over > 0}
							<span class="text-sky-700 dark:text-sky-300">{summary.over} zu viel</span>
						{/if}
					</div>
				</div>

				<Progress value={coverage} />

				{#if summary.missingHours > 0}
					<Alert.Root>
						<TriangleAlertIcon />
						<Alert.Title>
							{fmtHoursClock(summary.missingHours)} h sind in {monthLabel(active.month)} nicht erfasst
						</Alert.Title>
						<Alert.Description>
							Verglichen wird die Spalte „Arbeitszeit täglich" – die ist netto, LOGA hat die Pause
							dort bereits abgezogen.
							{#if app.settings.breakDeduction}
								Da die App die Pause ebenfalls abzieht, tragen die Vorschläge die
								<strong>Anwesenheit</strong> ein (Kommen bis Gehen); der Abzug ergibt daraus wieder
								die Stundenzahl aus dem Report.
							{:else}
								Vorgeschlagene Zeiten sparen die Pause deshalb als Lücke aus.
							{/if}
							Bereits erfasste Zeiten bleiben unberührt.
						</Alert.Description>
					</Alert.Root>
				{/if}

				{#if fixable.length > 0}
					<div class="flex flex-wrap items-center gap-2">
						<Button variant="outline" size="sm" onclick={() => toggleAll(picked.length < fixable.length)}>
							{picked.length < fixable.length ? "Alle auswählen" : "Auswahl aufheben"}
						</Button>
						<div class="w-56">
							<ActivityCombobox
								id="act-bulk"
								bind:value={bulkActivity}
								options={app.trackableActivities}
								placeholder="Alle Tage auf …"
							/>
						</div>
						<Button
							variant={splitOpen ? "secondary" : "outline"}
							size="sm"
							onclick={() => (splitOpen = !splitOpen)}
						>
							<SplitIcon class="size-3.5" /> Verteilen
						</Button>
						<span class="text-muted-foreground text-sm">
							{picked.length} ausgewählt
							{#if unassigned > 0}
								· <span class="text-amber-700 dark:text-amber-300">
									{unassigned} noch ohne Projekt
								</span>
							{/if}
						</span>
					</div>

					{#if splitOpen}
						<ProjectSplit
							options={app.trackableActivities}
							days={splittable.length}
							hours={splittableHours}
							onApply={applySplit}
						/>
					{/if}
				{/if}
			</div>

			<!-- Bewusst ohne eigenen Scrollbereich: die Aktivitäts-Combobox klappt ihre
			     Liste absolut positioniert auf, ein `overflow-y-auto` hier würde sie
			     abschneiden. Die Seite scrollt stattdessen, die Fußzeile bleibt sichtbar. -->
			<Tooltip.Provider>
				<div class="border-y">
					<Table.Root>
						<Table.Header class="bg-background sticky top-0 z-10">
							<Table.Row>
								<Table.Head class="w-10"></Table.Head>
								<Table.Head class="w-24">Tag</Table.Head>
								<Table.Head class="w-28">Stempel</Table.Head>
								<Table.Head class="w-20 text-right">LOGA</Table.Head>
								<Table.Head class="w-20 text-right">erfasst</Table.Head>
								<Table.Head class="w-24">Status</Table.Head>
								<Table.Head>Nachtrag</Table.Head>
							</Table.Row>
						</Table.Header>
						<Table.Body>
							{#each rows as { day, plan } (day.date)}
								{@const info = STATUS[day.status]}
								<Table.Row class={day.status === "ok" ? "text-muted-foreground" : ""}>
									<Table.Cell>
										{#if plan && !day.alreadyFilled}
											<Checkbox
												bind:checked={selected[day.date]}
												aria-label={`${dayLabel(day.date)} nachtragen`}
											/>
										{/if}
									</Table.Cell>
									<Table.Cell class="font-medium whitespace-nowrap">
										{dayLabel(day.date)}
										{#if day.report.flags.length > 0}
											<span class="ml-1 inline-flex gap-1 align-middle">
												{#each day.report.flags as f (f.key)}
													<Tooltip.Root>
														<Tooltip.Trigger>
															<Badge variant="outline" class="text-[10px] text-amber-700 dark:text-amber-300">
																{f.label}
															</Badge>
														</Tooltip.Trigger>
														<Tooltip.Content>
															{FLAG_HINT[f.key] ?? f.label}
															{#if f.value && f.value !== "X"}({f.value}){/if}
														</Tooltip.Content>
													</Tooltip.Root>
												{/each}
											</span>
										{/if}
									</Table.Cell>
									<Table.Cell class="text-muted-foreground font-mono text-xs whitespace-nowrap">
										{stampLabel(day)}
									</Table.Cell>
									<Table.Cell class="text-right font-mono tabular-nums">
										{fmtHoursClock(day.report.hours)}
									</Table.Cell>
									<Table.Cell class="text-right font-mono tabular-nums">
										{fmtHoursClock(day.tracked)}
									</Table.Cell>
									<Table.Cell>
										<span class={`rounded px-1.5 py-0.5 text-xs font-medium ${info.class}`}>
											{info.label}
										</span>
									</Table.Cell>
									<Table.Cell>
										{#if day.alreadyFilled}
											<span class="text-muted-foreground inline-flex items-center gap-1 text-xs">
												<CheckIcon class="size-3.5" /> bereits nachgetragen
											</span>
										{:else if plan?.kind === "absence"}
											<span class="inline-flex items-center gap-1.5 text-sm text-amber-700 dark:text-amber-300">
												<PalmtreeIcon class="size-3.5" />
												Abwesenheit · {planLabel(plan)}
											</span>
										{:else if plan?.kind === "time"}
											<div class="space-y-1.5">
												<div class="flex flex-wrap items-center gap-2">
													{#if splitFor[day.date]?.length}
														<!-- Verteilter Tag: statt einer Auswahl steht hier, wie der Tag
														     geschnitten wird. Das ✕ nimmt ihn wieder heraus. -->
														<span class="flex flex-wrap items-center gap-1">
															{#each splitBlocks(plan.blocks, splitFor[day.date]) as part, i (part.id)}
																{#if i > 0}<span class="text-muted-foreground text-xs">·</span>{/if}
																<Badge variant="secondary" class="font-normal">
																	{app.activityName(part.id)}
																	<span class="text-muted-foreground ml-1 font-mono text-[10px]">
																		{blockRanges(part.blocks)}
																	</span>
																</Badge>
															{/each}
															<Button
																variant="ghost"
																size="icon"
																class="size-6"
																aria-label={`Verteilung für ${dayLabel(day.date)} aufheben`}
																onclick={() => clearSplit(day.date)}
															>
																<XIcon class="size-3" />
															</Button>
														</span>
													{:else}
														<div class="w-52">
															<ActivityCombobox
																id={`act-${day.date}`}
																bind:value={activityFor[day.date]}
																options={app.trackableActivities}
															/>
														</div>
														<span class="text-muted-foreground font-mono text-xs">{planLabel(plan)}</span>
													{/if}
												</div>
												{#if plan.extraBlocks.length > 0}
													<!-- LOGA kennt mehr Stunden, als gestempelt wurde. Die gehören
													     meist nicht auf dasselbe Projekt wie der gestempelte Tag –
													     deshalb eine eigene Auswahl, vorbelegt mit „Others". -->
													<div class="flex flex-wrap items-center gap-2">
														<div class="w-52">
															<ActivityCombobox
																id={`extra-${day.date}`}
																bind:value={extraActivityFor[day.date]}
																options={app.trackableActivities}
																placeholder="Rest buchen auf …"
															/>
														</div>
														<span class="text-xs text-amber-700 dark:text-amber-300">
															+{fmtHoursClock(plan.extraHours)} h über die Stempelzeiten hinaus
															<span class="text-muted-foreground font-mono">
																({blockRanges(plan.extraBlocks)})
															</span>
														</span>
													</div>
												{/if}
											</div>
										{:else if day.status === "over"}
											{@const pause = breakHours(day.report)}
											<span class="text-muted-foreground text-xs">
												{fmtHoursClock(-day.diff)} h mehr erfasst als LOGA kennt
												{#if pause > 0 && !app.settings.breakDeduction}
													<!-- Nur ohne eigenen Abzug ist die Pause die Erklärung: der Timer
													     lief über sie hinweg, während LOGA sie abzieht. Mit aktivem
													     Abzug steht sie auf BEIDEN Seiten und erklärt nichts mehr. -->
													· LOGA zieht {fmtHoursClock(pause)} h Pause ab
												{/if}
											</span>
										{:else if day.status === "open"}
											<!-- Tag in LOGA noch nicht fertig – ein Vergleich sagt hier noch nichts. -->
											<span class="text-muted-foreground text-xs">
												in LOGA nur „Kommen" gestempelt ({day.report.firstIn})
											</span>
										{:else if day.status === "ok"}
											<span class="text-muted-foreground text-xs">—</span>
										{:else if day.blockedByAbsence}
											<span class="text-muted-foreground text-xs">Ganztags-Abwesenheit eingetragen</span>
										{:else if day.looksLikeAbsence}
											<!-- Ganztägige Abwesenheit und Projektzeit schließen sich aus. -->
											<span class="text-muted-foreground text-xs">
												Urlaub/Feiertag – am Tag ist bereits Projektzeit erfasst
											</span>
										{:else if ruleMismatch(day)}
											<!-- LOGA hat an diesem Tag anders abgezogen als die Hausregel
											     (gestempelte Zusatzpause, Korrekturbuchung) – laesst sich nicht
											     auffuellen, ohne Anwesenheit zu erfinden. -->
											<span class="text-muted-foreground text-xs">
												LOGA zieht hier {fmtHoursClock(breakHours(day.report))} h Pause ab statt
												{fmtHoursClock(ruleBreakHours(grossHours(day.report)))} h – Stempelzeiten sind
												vollständig erfasst
											</span>
										{:else}
											<span class="text-muted-foreground text-xs">kein Platz im Tag</span>
										{/if}
									</Table.Cell>
								</Table.Row>
							{/each}
						</Table.Body>
					</Table.Root>
				</div>
			</Tooltip.Provider>

			<!-- Bleibt beim Scrollen der langen Tabelle erreichbar. -->
			<div class="bg-card sticky bottom-0 flex justify-end gap-2 border-t px-6 py-3">
				<Button variant="outline" onclick={close} disabled={applying}>Schließen</Button>
				<Button onclick={apply} disabled={applying || chosen.length === 0}>
					{#if applying}<LoaderCircleIcon class="size-4 animate-spin" />{/if}
					{applying
						? "Übernehme…"
						: chosen.length > 0
							? `${chosen.length} Tag${chosen.length === 1 ? "" : "e"} übernehmen`
							: "Nichts ausgewählt"}
				</Button>
			</div>
		</Card.Content>
	{/if}
</Card.Root>
