<script lang="ts">
	import { app } from "$lib/app.svelte";
	import { createSettingsForm } from "$lib/settingsForm.svelte";
	import { scheduleReminders, scheduleReportReminder, ensureNotificationPermission } from "$lib/reminders";
	import { Button } from "$lib/components/ui/button";
	import { Input } from "$lib/components/ui/input";
	import { Label } from "$lib/components/ui/label";
	import SettingRow from "$lib/components/shared/SettingRow.svelte";
	import SettingsCard from "$lib/components/shared/SettingsCard.svelte";
	import SettingToggle from "$lib/components/shared/SettingToggle.svelte";
	import { isTauri } from "$lib/platform/env";
	import { toast } from "svelte-sonner";
	import BellIcon from "@lucide/svelte/icons/bell";
	import ClockIcon from "@lucide/svelte/icons/clock";
	import PlusIcon from "@lucide/svelte/icons/plus";
	import Trash2Icon from "@lucide/svelte/icons/trash-2";
	import CalendarClockIcon from "@lucide/svelte/icons/calendar-clock";
	import CheckCircle2Icon from "@lucide/svelte/icons/check-circle-2";
	import AlertTriangleIcon from "@lucide/svelte/icons/alert-triangle";

	const TIMES_KEYS = [
		"reminderTimes",
		"reportReminderEnabled",
		"reportReminderTime",
		"reportReminderLeadDays"
	] as const;

	const { form, save } = createSettingsForm();
	let savedTimesAt = $state(0);
	let savedReportReminderAt = $state(0);
	let notificationPermission = $state<NotificationPermission | "unknown">("unknown");
	let newTimeValue = $state("17:00");

	$effect(() => {
		if (isTauri() || typeof Notification === "undefined") return;
		notificationPermission = Notification.permission;
	});

	async function saveDailyTimes() {
		await save(["reminderTimes"]);
		scheduleReminders();
		if (app.settings.reminderTimes.length > 0) {
			await ensureNotificationPermission();
		}
		savedTimesAt = Date.now();
	}

	async function saveReportReminder() {
		await save(["reportReminderEnabled", "reportReminderTime", "reportReminderLeadDays"]);
		scheduleReportReminder();
		if (form.reportReminderEnabled) {
			await ensureNotificationPermission();
		}
		savedReportReminderAt = Date.now();
	}

	async function requestNotificationPermission() {
		const granted = await ensureNotificationPermission();
		notificationPermission = typeof Notification === "undefined" ? "denied" : Notification.permission;
		if (granted) toast.success("Benachrichtigungen sind jetzt erlaubt.");
		else toast.error("Der Browser hat die Erlaubnis nicht erteilt.");
	}

	function handleAddTime(timeToAdd?: string) {
		const time = timeToAdd || newTimeValue;
		if (!time) return;
		if (form.reminderTimes.includes(time)) {
			toast.info(`Die Uhrzeit ${time} ist bereits eingetragen.`);
			return;
		}
		form.reminderTimes = [...form.reminderTimes, time].sort();
		void saveDailyTimes();
	}

	function handleRemoveTime(index: number) {
		form.reminderTimes = form.reminderTimes.filter((_, i) => i !== index);
		void saveDailyTimes();
	}

	const quickPresets = ["12:00", "16:30", "17:00", "18:00"];
</script>

<div class="space-y-4">
	<!-- Browser Permission Banner -->
	{#if !isTauri()}
		{#if notificationPermission === "granted"}
			<div class="flex items-center gap-2.5 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-4 py-2.5 text-xs text-emerald-950 dark:text-emerald-200">
				<CheckCircle2Icon class="size-4 text-emerald-600 dark:text-emerald-400 shrink-0" />
				<span class="font-medium">Browser-Benachrichtigungen sind aktiv und erlaubt.</span>
			</div>
		{:else if notificationPermission === "denied"}
			<div class="flex items-start gap-3 rounded-lg border border-destructive/30 bg-destructive/10 p-3.5 text-xs text-destructive">
				<AlertTriangleIcon class="size-4 shrink-0 mt-0.5" />
				<div>
					<p class="font-semibold text-sm">Benachrichtigungen sind im Browser blockiert</p>
					<p class="mt-0.5 opacity-90 leading-relaxed">
						Erinnerungen und Timer-Warnungen bleiben stumm. Bitte erlaube Benachrichtigungen in deinen Browser-Einstellungen (Schloss-Symbol in der Adressleiste).
					</p>
				</div>
			</div>
		{:else}
			<div class="flex flex-col gap-3 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3.5 text-xs text-amber-950 dark:text-amber-200 sm:flex-row sm:items-center sm:justify-between">
				<div class="flex items-start gap-2.5">
					<AlertTriangleIcon class="size-4 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" />
					<div>
						<p class="font-semibold text-sm">Benachrichtigungen aktivieren</p>
						<p class="mt-0.5 opacity-90 leading-relaxed">
							Damit Erinnerungen auf diesem Gerät erscheinen können, benötigt der Browser deine Erlaubnis.
						</p>
					</div>
				</div>
				<Button size="sm" class="shrink-0 self-start sm:self-center" onclick={requestNotificationPermission}>
					Erlauben
				</Button>
			</div>
		{/if}
	{/if}

	<!-- Card 1: Tägliche Zeiterinnerungen -->
	<SettingsCard
		title="Tägliche Zeiterinnerung"
		description="Erinnert dich zu festen Uhrzeiten daran, deine Arbeitszeiten zu erfassen."
		savedAt={savedTimesAt}
	>
		<div class="space-y-4">
			<!-- Active times list -->
			{#if form.reminderTimes.length > 0}
				<div class="space-y-2">
					<Label class="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
						Aktive Erinnerungszeiten ({form.reminderTimes.length})
					</Label>
					<div class="grid gap-2 sm:grid-cols-2">
						{#each form.reminderTimes as time, i (time)}
							<div class="flex items-center justify-between gap-3 rounded-lg border bg-card/60 p-2.5 transition-colors hover:bg-card">
								<div class="flex items-center gap-2.5 min-w-0">
									<div class="flex size-7 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
										<ClockIcon class="size-3.5" />
									</div>
									<span class="font-mono text-sm font-medium tracking-tight text-foreground">{time} Uhr</span>
								</div>
								<Button
									variant="ghost"
									size="icon-sm"
									class="text-muted-foreground hover:text-destructive hover:bg-destructive/10 shrink-0"
									title="Uhrzeit entfernen"
									onclick={() => handleRemoveTime(i)}
								>
									<Trash2Icon class="size-3.5" />
								</Button>
							</div>
						{/each}
					</div>
				</div>
			{:else}
				<div class="rounded-lg border border-dashed p-6 text-center">
					<BellIcon class="size-8 mx-auto text-muted-foreground/50 mb-2" />
					<p class="text-sm font-medium text-foreground">Keine Erinnerungen aktiv</p>
					<p class="text-xs text-muted-foreground mt-0.5">
						Füge eine Uhrzeit hinzu, um täglich an deine Zeiterfassung erinnert zu werden.
					</p>
				</div>
			{/if}

			<!-- Add Time Section & Presets -->
			<div class="rounded-lg border bg-muted/20 p-3.5 space-y-3">
				<div>
					<p class="font-medium text-xs text-foreground">Neue Erinnerungszeit hinzufügen</p>
				</div>
				<div class="flex flex-wrap items-center gap-2">
					<Input
						type="time"
						class="w-36 h-9 font-mono text-sm bg-background"
						bind:value={newTimeValue}
						onkeydown={(e) => e.key === "Enter" && handleAddTime()}
					/>
					<Button size="sm" class="h-9 gap-1.5" onclick={() => handleAddTime()}>
						<PlusIcon class="size-4" /> Hinzufügen
					</Button>
				</div>

				<!-- Quick Presets -->
				<div class="flex flex-wrap items-center gap-1.5 pt-1">
					<span class="text-xs text-muted-foreground mr-1">Vorschläge:</span>
					{#each quickPresets as preset (preset)}
						<button
							type="button"
							class="inline-flex items-center gap-1 rounded-md border bg-background px-2 py-0.5 text-xs text-muted-foreground transition-colors hover:text-foreground hover:border-foreground/30"
							onclick={() => handleAddTime(preset)}
						>
							<PlusIcon class="size-3" /> {preset}
						</button>
					{/each}
				</div>
			</div>
		</div>
	</SettingsCard>

	<!-- Card 2: Monatsbericht-Erinnerung -->
	<SettingsCard
		title="Monatsbericht-Erinnerung"
		description="Erinnert dich rechtzeitig vor Monatsende daran, deinen fertigen Monatsbericht abzusenden."
		savedAt={savedReportReminderAt}
	>
		<div class="space-y-4">
			<SettingToggle
				id="reprem"
				title="Monatliche Berichtserinnerung aktivieren"
				description="Benachrichtigt dich automatisch am letzten Arbeitstag des Monats."
				bind:checked={form.reportReminderEnabled}
				onCheckedChange={(v) => {
					form.reportReminderEnabled = v;
					void saveReportReminder();
				}}
			/>

			{#if form.reportReminderEnabled}
				<div class="rounded-lg border bg-muted/30 p-3.5 space-y-3">
					<div class="flex items-center gap-2 text-primary font-medium text-xs">
						<CalendarClockIcon class="size-4" />
						<span>Zeitplan für die Berichts-Erinnerung</span>
					</div>

					<div class="grid gap-3 sm:grid-cols-2">
						<div class="space-y-1.5">
							<Label for="replead" class="text-xs font-medium">Vorlaufzeit</Label>
							<div class="flex items-center gap-2">
								<Input
									id="replead"
									type="number"
									min="0"
									max="10"
									class="w-24 bg-background"
									bind:value={form.reportReminderLeadDays}
									onchange={saveReportReminder}
								/>
								<span class="text-xs text-muted-foreground">
									{Number(form.reportReminderLeadDays) === 0
										? "am letzten Werktag"
										: `${form.reportReminderLeadDays} Werktag${Number(form.reportReminderLeadDays) === 1 ? "" : "e"} vorher`}
								</span>
							</div>
						</div>

						<div class="space-y-1.5">
							<Label for="reptime" class="text-xs font-medium">Uhrzeit der Benachrichtigung</Label>
							<Input
								id="reptime"
								type="time"
								class="w-36 bg-background font-mono text-sm"
								bind:value={form.reportReminderTime}
								onchange={saveReportReminder}
							/>
						</div>
					</div>
				</div>
			{/if}
		</div>
	</SettingsCard>
</div>
