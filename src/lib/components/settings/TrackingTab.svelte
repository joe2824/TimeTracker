<script lang="ts">
	import { app } from "$lib/app.svelte";
	import { formFromSettings, patchFrom, syncForm } from "$lib/settingsSync";
	import type { Settings } from "$lib/types";
	import { Button } from "$lib/components/ui/button";
	import { Input } from "$lib/components/ui/input";
	import { Label } from "$lib/components/ui/label";
	import WorkdayPicker from "$lib/components/WorkdayPicker.svelte";
	import SettingRow from "$lib/components/SettingRow.svelte";
	import SettingsCard from "$lib/components/SettingsCard.svelte";
	import SettingToggle from "$lib/components/SettingToggle.svelte";
	import ShortcutKey from "$lib/components/ShortcutKey.svelte";
	import * as Select from "$lib/components/ui/select";
	import { capabilities } from "$lib/platform/env";
	import { acceleratorFromEvent, applyShortcuts } from "$lib/shortcuts";
	import XIcon from "@lucide/svelte/icons/x";

	const ROUNDINGS: Record<string, string> = {
		"0.25": "Viertelstunde (0:15)",
		"0.5": "Halbe Stunde (0:30)",
		"1": "Volle Stunde (1:00)"
	};

	const TRACKING_KEYS = [
		"idleThresholdMin",
		"maxTimerHours",
		"pomodoroEnabled",
		"pomodoroMin",
		"pomodoroBreakMin",
		"shortcutNotify"
	] as const;

	const WORKTIME_KEYS = ["rounding", "hoursPerDay", "breakDeduction", "workdays"] as const;

	function getCurrentSettings(): Settings {
		return $state.snapshot(app.settings) as Settings;
	}

	let form = $state(formFromSettings(getCurrentSettings()));
	let synced = getCurrentSettings();
	let isRecordingShortcut = $state(false);
	let savedTrackingAt = $state(0);
	let savedWorktimeAt = $state(0);

	$effect(() => {
		synced = syncForm(form, synced, getCurrentSettings());
	});

	async function saveFields(keys: readonly (keyof Settings)[]): Promise<void> {
		await app.updateSettings(patchFrom(form, keys, getCurrentSettings()));
	}

	async function saveTracking() {
		await saveFields(TRACKING_KEYS);
		savedTrackingAt = Date.now();
	}

	async function saveWorktime() {
		await saveFields(WORKTIME_KEYS);
		savedWorktimeAt = Date.now();
	}

	async function handleShortcutKeyDown(e: KeyboardEvent) {
		if (!isRecordingShortcut) return;
		e.preventDefault();
		if (e.key === "Escape") {
			isRecordingShortcut = false;
			return;
		}
		if (e.key === "Backspace" || e.key === "Delete") {
			await app.updateSettings({ toggleShortcut: "" });
			isRecordingShortcut = false;
			await applyShortcuts();
			return;
		}
		const accelerator = acceleratorFromEvent(e);
		if (!accelerator) return;
		await app.updateSettings({ toggleShortcut: accelerator });
		isRecordingShortcut = false;
		await applyShortcuts();
	}

	async function handleClearShortcut() {
		await app.updateSettings({ toggleShortcut: "" });
		await applyShortcuts();
	}

	const timeZones = $derived.by(() => {
		let list: string[] = [];
		try {
			list = Intl.supportedValuesOf?.("timeZone") ?? [];
		} catch {
			list = [];
		}
		const current = app.settings.timeZone;
		return list.includes(current) || !current ? list : [current, ...list];
	});

	async function handleSaveTimeZone(tz: string) {
		if (!tz || tz === app.settings.timeZone) return;
		await app.updateSettings({ timeZone: tz });
		app.entriesVersion++;
		savedWorktimeAt = Date.now();
	}
</script>

<svelte:window onkeydown={handleShortcutKeyDown} />

<SettingsCard
	title="Timer & Hotkey"
	description="Verhalten von Timer, Hinweisen und Tastenkürzel."
	savedAt={savedTrackingAt}
>
	{#if capabilities.idleDetection}
		<SettingRow
			id="idle"
			title="Leerlauf nachfragen ab"
			description="Nach so vielen Minuten ohne Eingabe nachfragen. 0 = aus."
		>
			{#snippet control()}
				<Input
					id="idle"
					type="number"
					min="0"
					class="w-24"
					bind:value={form.idleThresholdMin}
					onchange={saveTracking}
				/>
			{/snippet}
		</SettingRow>
	{/if}

	<SettingRow
		id="maxh"
		title="Auto-Stop-Warnung ab"
		description="Warnen, wenn ein Timer länger als so viele Stunden läuft. 0 = aus."
	>
		{#snippet control()}
			<Input
				id="maxh"
				type="number"
				min="0"
				class="w-24"
				bind:value={form.maxTimerHours}
				onchange={saveTracking}
			/>
		{/snippet}
	</SettingRow>

	{#if capabilities.globalShortcuts}
		<SettingToggle
			id="scnotify"
			title="Hinweis bei Shortcut-Start/Stop"
			description="Kurze Meldung, verschwindet selbst."
			bind:checked={form.shortcutNotify}
			onCheckedChange={() => saveTracking()}
		/>
	{/if}

	<div class="space-y-3">
		<SettingToggle
			id="pomo"
			title="Pomodoro"
			description="Fokus-/Pausen-Zyklus mit Hinweisen (optional)."
			bind:checked={form.pomodoroEnabled}
			onCheckedChange={() => saveTracking()}
		/>
		{#if form.pomodoroEnabled}
			<div class="bg-muted/40 grid gap-3 rounded-lg p-3 sm:max-w-md sm:grid-cols-2">
				<div class="space-y-1.5">
					<Label for="pomomin">Fokus (Min)</Label>
					<Input
						id="pomomin"
						type="number"
						min="1"
						bind:value={form.pomodoroMin}
						onchange={saveTracking}
					/>
				</div>
				<div class="space-y-1.5">
					<Label for="pomobreak">Pause (Min, 0 = aus)</Label>
					<Input
						id="pomobreak"
						type="number"
						min="0"
						bind:value={form.pomodoroBreakMin}
						onchange={saveTracking}
					/>
				</div>
			</div>
		{/if}
	</div>

	{#if capabilities.globalShortcuts}
		<SettingRow
			title="Globaler Start/Stop-Hotkey"
			description="Startet/stoppt den zuletzt benutzten Timer – auch wenn die App im Hintergrund ist."
		>
			{#snippet control()}
				<div class="flex items-center gap-1">
					{#if isRecordingShortcut}
						<span class="text-muted-foreground text-sm italic">Taste drücken… (Esc=Abbruch)</span>
					{:else if app.settings.toggleShortcut}
						<ShortcutKey
							shortcut={app.settings.toggleShortcut}
							onclick={() => (isRecordingShortcut = true)}
						/>
						<Button variant="ghost" size="icon-sm" onclick={handleClearShortcut} title="Entfernen">
							<XIcon />
						</Button>
					{:else}
						<Button variant="outline" size="sm" onclick={() => (isRecordingShortcut = true)}>
							Festlegen…
						</Button>
					{/if}
				</div>
			{/snippet}
		</SettingRow>
	{/if}
</SettingsCard>

<SettingsCard
	title="Arbeitszeit"
	description="Arbeitstage & -zeit – Basis für Abwesenheiten und Bericht."
	savedAt={savedWorktimeAt}
>
	<div class="space-y-2">
		<Label>An welchen Tagen arbeitest du?</Label>
		<WorkdayPicker bind:value={form.workdays} onchange={saveWorktime} />
		<p class="text-muted-foreground text-xs leading-relaxed">
			Nicht-Arbeitstage (z.&nbsp;B. Wochenende) werden beim Kalender-Import und bei
			Abwesenheits-Zeiträumen übersprungen und tauchen nicht im Bericht auf.
		</p>
	</div>
	<SettingRow
		id="tz"
		title="Zeitzone"
		description="Bestimmt, wo ein Arbeitstag anfängt und aufhört. Beim Wechsel rutschen bereits erfasste Einträge auf einen anderen Kalendertag."
	>
		{#snippet control()}
			<select
				id="tz"
				class="border-input bg-background ring-offset-background focus-visible:ring-ring h-9 w-56 rounded-md border px-3 py-1 text-sm focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none"
				value={app.settings.timeZone}
				onchange={(e) => handleSaveTimeZone(e.currentTarget.value)}
			>
				{#each timeZones as tz (tz)}
					<option value={tz}>{tz}</option>
				{/each}
			</select>
		{/snippet}
	</SettingRow>
	<SettingRow
		id="hpd"
		title="Stunden / Arbeitstag"
		description="Als Uhrzeit, z. B. 07:30. Ganzer Abwesenheitstag = dieser Wert."
	>
		{#snippet control()}
			<Input
				id="hpd"
				type="time"
				class="w-32"
				bind:value={form.hoursPerDay}
				onchange={saveWorktime}
			/>
		{/snippet}
	</SettingRow>
	<SettingToggle
		id="breakded"
		title="Pause automatisch abziehen"
		description="Ab 4 h Tagesarbeitszeit 15 Minuten, ab 6 h insgesamt 45 – wie LOGA es rechnet. Wirkt auf Tagessummen, Bericht und Auswertung; die erfassten Einträge bleiben unverändert."
		bind:checked={form.breakDeduction}
		onCheckedChange={() => saveWorktime()}
	/>
	<SettingRow id="round" title="Rundung" description="Stunden je Aktivität im Bericht.">
		{#snippet control()}
			<Select.Root type="single" bind:value={form.rounding} onValueChange={() => saveWorktime()}>
				<Select.Trigger id="round" class="w-48">
					{ROUNDINGS[form.rounding] ?? form.rounding}
				</Select.Trigger>
				<Select.Content>
					{#each Object.entries(ROUNDINGS) as [v, label] (v)}
						<Select.Item value={v} {label}>{label}</Select.Item>
					{/each}
				</Select.Content>
			</Select.Root>
		{/snippet}
	</SettingRow>
</SettingsCard>
