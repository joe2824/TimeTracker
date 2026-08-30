<script lang="ts">
	import { onMount } from "svelte";
	import { app } from "$lib/app.svelte";
	import { formFromSettings, patchFrom, syncForm } from "$lib/settingsSync";
	import type { Settings } from "$lib/types";
	import { listEntryYears, type StoredYear } from "$lib/store";
	import { Button } from "$lib/components/ui/button";
	import * as Dialog from "$lib/components/ui/dialog";
	import SettingRow from "$lib/components/SettingRow.svelte";
	import SettingsCard from "$lib/components/SettingsCard.svelte";
	import SettingToggle from "$lib/components/SettingToggle.svelte";
	import { capabilities, isTauri } from "$lib/platform/env";
	import { enable, disable, isEnabled } from "@tauri-apps/plugin-autostart";
	import { checkForUpdate, updater } from "$lib/updater.svelte";
	import { relaunch } from "@tauri-apps/plugin-process";
	import { errorText, flushLog, logInfo } from "$lib/log";
	import { toast } from "svelte-sonner";
	import Trash2Icon from "@lucide/svelte/icons/trash-2";

	function getCurrentSettings(): Settings {
		return $state.snapshot(app.settings) as Settings;
	}

	let form = $state(formFromSettings(getCurrentSettings()));
	let synced = getCurrentSettings();
	let savedSystemAt = $state(0);
	let isChannelChanged = $state(false);
	let storedYears = $state<StoredYear[]>([]);
	let yearToDelete = $state<StoredYear | null>(null);
	let isDeletingYear = $state(false);

	$effect(() => {
		synced = syncForm(form, synced, getCurrentSettings());
	});

	onMount(async () => {
		if (capabilities.autostart) {
			try {
				form.autostart = await isEnabled();
			} catch (e) {
				toast.error(`Autostart-Status nicht lesbar: ${e}`, { duration: 60000 });
			}
		}
	});

	$effect(() => {
		app.entriesVersion;
		void listEntryYears().then((y) => (storedYears = y));
	});

	async function toggleAutostart(v: boolean) {
		try {
			if (v) await enable();
			else await disable();
			await app.updateSettings({ autostart: v });
			savedSystemAt = Date.now();
		} catch (e) {
			form.autostart = !v;
			toast.error(`Autostart fehlgeschlagen: ${e}`, { duration: 60000 });
		}
	}

	async function saveBetaUpdates() {
		await app.updateSettings(patchFrom(form, ["betaUpdates"], getCurrentSettings()));
		savedSystemAt = Date.now();
		isChannelChanged = true;
		logInfo(`Update-Kanal umgestellt auf ${form.betaUpdates ? "Beta" : "stabil"}`);
	}

	async function restartApp() {
		try {
			await flushLog();
			await relaunch();
		} catch (e) {
			toast.error(`Neustart nicht möglich: ${errorText(e)}`, { duration: 60000 });
		}
	}

	function handleCheckUpdate() {
		void checkForUpdate();
	}

	async function handleConfirmDeleteYear() {
		const target = yearToDelete;
		if (!target) return;
		isDeletingYear = true;
		try {
			const months = await app.deleteYearEntries(target.year);
			toast.success(`${target.year} gelöscht (${months} Monatsdatei${months === 1 ? "" : "en"}).`);
			yearToDelete = null;
		} catch (e) {
			toast.error(`Löschen fehlgeschlagen: ${e}`);
		} finally {
			isDeletingYear = false;
		}
	}
</script>

{#if capabilities.autostart || capabilities.updater}
	<SettingsCard
		title="Start & Updates"
		description="Wie die App startet und woher sie neue Versionen holt."
		savedAt={savedSystemAt}
	>
		{#if capabilities.autostart}
			<SettingToggle
				id="autostart"
				title="Mit Windows starten"
				description="App läuft im Hintergrund (Tray)."
				bind:checked={form.autostart}
				onCheckedChange={toggleAutostart}
			/>
		{/if}
		<div class="space-y-3">
			<SettingToggle
				id="beta"
				title="Vorabversionen (Beta)"
				description="Neue Funktionen früher bekommen – dafür kann auch mal etwas klemmen. Aus heißt: nur fertige Versionen."
				bind:checked={form.betaUpdates}
				onCheckedChange={saveBetaUpdates}
			/>
			{#if isChannelChanged}
				<div class="bg-muted/40 flex flex-wrap items-center gap-2 rounded-lg p-3 text-sm">
					<span class="text-muted-foreground">Wirkt nach einem Neustart der App.</span>
					<Button variant="outline" size="sm" onclick={restartApp}>Jetzt neu starten</Button>
				</div>
			{/if}
		</div>
		<SettingRow
			title="Version prüfen"
			description="Sucht sofort nach einer neueren Version, statt auf die Prüfung beim Start zu warten."
		>
			{#snippet control()}
				<Button variant="outline" size="sm" onclick={handleCheckUpdate} disabled={updater.checking}>
					{updater.checking ? "Suche…" : "Nach Updates suchen"}
				</Button>
			{/snippet}
		</SettingRow>
	</SettingsCard>
{/if}

{#if isTauri()}
	<SettingsCard
		title="Daten auf diesem Gerät"
		description="Löscht nur hier. Bei einem verknüpften Konto bleiben die Zeiten auf dem Server und kommen beim nächsten Abgleich zurück – dort löschst du über „Konto auflösen“."
	>
		{#if storedYears.length === 0}
			<p class="text-muted-foreground text-sm">Noch keine erfassten Zeiten.</p>
		{:else}
			{#each storedYears as y (y.year)}
				<div class="flex items-center justify-between gap-3">
					<div>
						<div class="text-sm font-medium">{y.year}</div>
						<div class="text-muted-foreground text-xs">
							{y.months} Monat{y.months === 1 ? "" : "e"} · {y.entries} Eintr{y.entries === 1
								? "ag"
								: "äge"}
						</div>
					</div>
					<Button variant="destructive" size="sm" onclick={() => (yearToDelete = y)}>
						<Trash2Icon class="size-4" /> Löschen
					</Button>
				</div>
			{/each}
		{/if}
	</SettingsCard>
{/if}

<Dialog.Root open={yearToDelete !== null} onOpenChange={(o) => !o && (yearToDelete = null)}>
	<Dialog.Content>
		<Dialog.Header>
			<Dialog.Title>{yearToDelete?.year} löschen?</Dialog.Title>
			<Dialog.Description>
				{yearToDelete?.entries} Einträge aus {yearToDelete?.months} Monat{yearToDelete?.months === 1
					? ""
					: "e"} werden endgültig gelöscht. Das lässt sich nicht rückgängig machen.
			</Dialog.Description>
		</Dialog.Header>
		<Dialog.Footer>
			<Button variant="outline" disabled={isDeletingYear} onclick={() => (yearToDelete = null)}>
				Abbrechen
			</Button>
			<Button disabled={isDeletingYear} onclick={handleConfirmDeleteYear}>
				{isDeletingYear ? "Lösche…" : `${yearToDelete?.year} endgültig löschen`}
			</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>

