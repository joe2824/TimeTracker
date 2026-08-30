<script lang="ts">
	import { app } from "$lib/app.svelte";
	import { formFromSettings, patchFrom, syncForm } from "$lib/settingsSync";
	import { scheduleReminders, scheduleReportReminder, ensureNotificationPermission } from "$lib/reminders";
	import type { Settings } from "$lib/types";
	import { Button } from "$lib/components/ui/button";
	import { Input } from "$lib/components/ui/input";
	import SettingRow from "$lib/components/SettingRow.svelte";
	import SettingsCard from "$lib/components/SettingsCard.svelte";
	import SettingToggle from "$lib/components/SettingToggle.svelte";
	import { isTauri } from "$lib/platform/env";
	import { toast } from "svelte-sonner";
	import PlusIcon from "@lucide/svelte/icons/plus";
	import Trash2Icon from "@lucide/svelte/icons/trash-2";

	const TIMES_KEYS = [
		"reminderTimes",
		"reportReminderEnabled",
		"reportReminderTime",
		"reportReminderLeadDays"
	] as const;

	function getCurrentSettings(): Settings {
		return $state.snapshot(app.settings) as Settings;
	}

	let form = $state(formFromSettings(getCurrentSettings()));
	let synced = getCurrentSettings();
	let savedTimesAt = $state(0);
	let notificationPermission = $state<NotificationPermission | "unknown">("unknown");

	$effect(() => {
		synced = syncForm(form, synced, getCurrentSettings());
	});

	$effect(() => {
		if (isTauri() || typeof Notification === "undefined") return;
		notificationPermission = Notification.permission;
	});

	async function saveTimes() {
		await app.updateSettings(patchFrom(form, TIMES_KEYS, getCurrentSettings()));
		scheduleReminders();
		scheduleReportReminder();
		if (app.settings.reminderTimes.length > 0 || form.reportReminderEnabled) {
			await ensureNotificationPermission();
		}
		savedTimesAt = Date.now();
	}

	async function requestNotificationPermission() {
		const granted = await ensureNotificationPermission();
		notificationPermission = typeof Notification === "undefined" ? "denied" : Notification.permission;
		if (granted) toast.success("Benachrichtigungen sind jetzt erlaubt.");
		else toast.error("Der Browser hat die Erlaubnis nicht gegeben.");
	}
</script>

<SettingsCard
	title="Tägliche Erinnerungen"
	description="Zu diesen Uhrzeiten erinnert dich die App, deine Zeiten einzutragen."
	savedAt={savedTimesAt}
>
	<div class="space-y-3">
		{#if !isTauri()}
			{#if notificationPermission === "granted"}
				<p class="text-muted-foreground flex items-center gap-1.5 text-xs">
					<span class="size-1.5 rounded-full bg-emerald-500"></span>
					Benachrichtigungen sind für diesen Browser erlaubt.
				</p>
			{:else if notificationPermission === "denied"}
				<div class="rounded-lg border border-amber-500/40 bg-amber-500/5 p-3 text-sm">
					<p class="font-medium">Benachrichtigungen sind blockiert.</p>
					<p class="text-muted-foreground mt-1 text-xs leading-relaxed">
						Ohne sie kommt hier nichts an – weder Erinnerungen noch die Auto-Stopp-Warnung. Das
						lässt sich nur in den Einstellungen des Browsers wieder erlauben (Schloss-Symbol
						neben der Adresse).
					</p>
				</div>
			{:else}
				<div class="rounded-lg border border-amber-500/40 bg-amber-500/5 p-3 text-sm">
					<p class="font-medium">Benachrichtigungen sind noch nicht erlaubt.</p>
					<p class="text-muted-foreground mt-1 mb-2 text-xs leading-relaxed">
						Solange nicht, bleiben Erinnerungen und die Auto-Stopp-Warnung stumm.
					</p>
					<Button size="sm" onclick={requestNotificationPermission}>Benachrichtigungen erlauben</Button>
				</div>
			{/if}
		{/if}

		{#each form.reminderTimes as _, i (i)}
			<div class="flex items-center gap-2">
				<Input
					type="time"
					class="w-32"
					bind:value={form.reminderTimes[i]}
					onchange={saveTimes}
				/>
				<Button
					variant="ghost"
					size="icon"
					title="Uhrzeit entfernen"
					onclick={() => {
						form.reminderTimes = form.reminderTimes.filter((_, j) => j !== i);
						void saveTimes();
					}}
				>
					<Trash2Icon class="size-4" />
				</Button>
			</div>
		{/each}

		{#if form.reminderTimes.length === 0}
			<p class="text-muted-foreground text-sm">Noch keine Uhrzeit eingetragen.</p>
		{/if}

		<Button
			variant="outline"
			size="sm"
			onclick={() => {
				form.reminderTimes = [...form.reminderTimes, "14:00"];
				void saveTimes();
			}}
		>
			<PlusIcon class="size-4" /> Uhrzeit
		</Button>
	</div>

	<div class="space-y-3">
		<SettingToggle
			id="reprem"
			title="Monatlicher Bericht-Hinweis"
			description="Am letzten Werktag erinnern, den Bericht zu senden."
			bind:checked={form.reportReminderEnabled}
			onCheckedChange={() => saveTimes()}
		/>
		{#if form.reportReminderEnabled}
			<div class="bg-muted/40 space-y-3 rounded-lg p-3">
				<SettingRow id="replead" title="Werktage vorher" description="0 = letzter Werktag.">
					{#snippet control()}
						<Input
							id="replead"
							type="number"
							min="0"
							max="10"
							class="w-24"
							bind:value={form.reportReminderLeadDays}
							onchange={saveTimes}
						/>
					{/snippet}
				</SettingRow>
				<SettingRow id="reptime" title="Uhrzeit" description="Wann an diesem Tag erinnert wird.">
					{#snippet control()}
						<Input
							id="reptime"
							type="time"
							class="w-32"
							bind:value={form.reportReminderTime}
							onchange={saveTimes}
						/>
					{/snippet}
				</SettingRow>
			</div>
		{/if}
	</div>
</SettingsCard>
