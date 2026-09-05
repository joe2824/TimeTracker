<script lang="ts">
	import { onMount } from "svelte";
	import { app } from "$lib/app.svelte";
	import { createSettingsForm } from "$lib/ui/settingsForm.svelte";
	import { listEntryYears, type StoredYear } from "$lib/store";
	import { Button } from "$lib/components/ui/button";
	import * as Dialog from "$lib/components/ui/dialog";
	import SettingRow from "$lib/components/shared/SettingRow.svelte";
	import SettingsCard from "$lib/components/shared/SettingsCard.svelte";
	import SettingToggle from "$lib/components/shared/SettingToggle.svelte";
	import { capabilities, isTauri } from "$lib/platform/env";
	import { account } from "$lib/sync/account.svelte";
	import { enable, disable, isEnabled } from "@tauri-apps/plugin-autostart";
	import { checkForUpdate, updater } from "$lib/release/updater.svelte";
	import { relaunch } from "@tauri-apps/plugin-process";
	import { errorText, flushLog, logInfo } from "$lib/log";
	import { toast } from "svelte-sonner";
	import Trash2Icon from "@lucide/svelte/icons/trash-2";

	import DownloadIcon from "@lucide/svelte/icons/download";
	import UploadIcon from "@lucide/svelte/icons/upload";
	import FileTextIcon from "@lucide/svelte/icons/file-text";
	import CheckCircle2Icon from "@lucide/svelte/icons/check-circle-2";
	import TriangleAlertIcon from "@lucide/svelte/icons/triangle-alert";
	import {
		downloadBackupFile,
		inspectBackup,
		restoreBackup,
		type BackupStats,
		type TimeTrackerBackup
	} from "$lib/report/backup";

	const { form, save } = createSettingsForm();
	let savedSystemAt = $state(0);
	let isChannelChanged = $state(false);
	let storedYears = $state<StoredYear[]>([]);
	let yearToDelete = $state<StoredYear | null>(null);
	let isDeletingYear = $state(false);

	// Backup & Restore
	let isExportingBackup = $state(false);
	let isRestoringBackup = $state(false);
	let restoreFileInput = $state<HTMLInputElement | null>(null);
	let pendingBackup = $state<TimeTrackerBackup | null>(null);
	let pendingBackupStats = $state<BackupStats | null>(null);
	let restoreMode = $state<"merge" | "replace">("merge");
	// Solange aeltere Monate nachkommen, waere eine Sicherung nur ein Ausschnitt und
	// ein Einspielen wuerde vom Nachschub teilweise ueberschrieben.
	const backupBlocked = $derived(account.historyIncomplete);

	async function handleExportBackup() {
		isExportingBackup = true;
		try {
			const res = await downloadBackupFile();
			if (res.success) {
				toast.success(res.filename ? `Sicherung gespeichert: ${res.filename}` : "Sicherung erfolgreich exportiert.");
			}
		} catch (e) {
			toast.error(`Sicherung fehlgeschlagen: ${errorText(e)}`);
		} finally {
			isExportingBackup = false;
		}
	}

	function handleTriggerRestore() {
		restoreFileInput?.click();
	}

	async function handleFileSelected(e: Event) {
		const target = e.target as HTMLInputElement;
		const file = target.files?.[0];
		if (!file) return;

		try {
			const text = await file.text();
			const result = inspectBackup(text);
			if (!result.valid || !result.backup || !result.stats) {
				toast.error(result.error || "Ungültige Sicherungsdatei");
				return;
			}
			pendingBackup = result.backup;
			pendingBackupStats = result.stats;
			restoreMode = "merge";
		} catch (err) {
			toast.error(`Datei konnte nicht gelesen werden: ${errorText(err)}`);
		} finally {
			target.value = "";
		}
	}

	async function handleConfirmRestore() {
		if (!pendingBackup) return;
		isRestoringBackup = true;
		try {
			const result = await restoreBackup(pendingBackup, restoreMode);
			toast.success(
				`Sicherung erfolgreich wiederhergestellt (${result.restoredMonths} Monat${result.restoredMonths === 1 ? "" : "e"}, ${result.restoredEntries} Einträge).`
			);
			pendingBackup = null;
			pendingBackupStats = null;
		} catch (e) {
			toast.error(`Wiederherstellung fehlgeschlagen: ${errorText(e)}`);
		} finally {
			isRestoringBackup = false;
		}
	}

	onMount(async () => {
		if (capabilities.autostart) {
			try {
				form.autostart = await isEnabled();
			} catch (e) {
				toast.error(`Autostart-Status nicht lesbar: ${e}`, { duration: 60000 });
			}
		}
	});

	// Nur auf dem Rechner: die Karte darunter steht unter `{#if isTauri()}`, im
	// Browser wuerde hier bei jeder Aenderung jede Monatsdatei gelesen - fuer
	// Zahlen, die niemand zu sehen bekommt.
	$effect(() => {
		if (!isTauri()) return;
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
		await save(["betaUpdates"]);
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

	<SettingsCard
		title="Sicherung & PC-Wechsel"
		description="Sichere alle deine Aktivitäten, Einstellungen und erfassten Zeiten als Datei – für den Umzug auf einen neuen Rechner oder als persönliche Sicherheitskopie."
	>
		<input
			type="file"
			accept=".json,application/json"
			bind:this={restoreFileInput}
			onchange={handleFileSelected}
			class="hidden"
		/>

		<div class="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
			<div class="space-y-0.5">
				<div class="text-sm font-medium">Sicherungsdatei erstellen</div>
				<div class="text-muted-foreground text-xs">
					Exportiert den gesamten lokalen Datenbestand in eine lesbare .json-Datei.
				</div>
			</div>
			<Button
				variant="outline"
				size="sm"
				class="shrink-0 gap-2 self-start sm:self-center"
				disabled={isExportingBackup || backupBlocked}
				onclick={handleExportBackup}
			>
				<DownloadIcon class="size-4 {isExportingBackup ? 'animate-bounce' : ''}" />
				{isExportingBackup ? "Erstelle Sicherung…" : "Sicherung exportieren"}
			</Button>
		</div>

		<div class="flex flex-col gap-3 border-t pt-3 sm:flex-row sm:items-center sm:justify-between">
			<div class="space-y-0.5">
				<div class="text-sm font-medium">Sicherung wiederherstellen</div>
				<div class="text-muted-foreground text-xs">
					Liest eine zuvor erstellte Sicherungsdatei ein (z. B. auf einem neuen PC).
				</div>
			</div>
			<Button
				variant="outline"
				size="sm"
				class="shrink-0 gap-2 self-start sm:self-center"
				disabled={backupBlocked}
				onclick={handleTriggerRestore}
			>
				<UploadIcon class="size-4" />
				Sicherung einlesen…
			</Button>
		</div>

		{#if backupBlocked}
			<div class="text-muted-foreground border-t pt-3 text-xs">
				Ältere Monate werden gerade noch geladen. Sichern und Einlesen gehen wieder,
				sobald alles da ist.
			</div>
		{/if}
	</SettingsCard>

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

<!-- Dialog: Sicherung wiederherstellen -->
<Dialog.Root open={pendingBackup !== null} onOpenChange={(o) => !o && (pendingBackup = null)}>
	<Dialog.Content class="sm:max-w-md">
		<Dialog.Header>
			<Dialog.Title class="flex items-center gap-2">
				<FileTextIcon class="size-5 text-primary" />
				Sicherung wiederherstellen
			</Dialog.Title>
			<Dialog.Description class="pt-2 text-left space-y-3">
				{#if pendingBackupStats}
					<div class="rounded-lg border bg-muted/40 p-3 text-xs space-y-1.5">
						<div class="flex justify-between text-foreground font-medium">
							<span>Aktivitäten:</span>
							<span>{pendingBackupStats.activityCount}</span>
						</div>
						<div class="flex justify-between text-foreground font-medium">
							<span>Erfasste Monate:</span>
							<span>{pendingBackupStats.monthCount} {pendingBackupStats.months.length > 0 ? `(${pendingBackupStats.months[0]} bis ${pendingBackupStats.months[pendingBackupStats.months.length - 1]})` : ""}</span>
						</div>
						<div class="flex justify-between text-foreground font-medium">
							<span>Gesamteinträge:</span>
							<span>{pendingBackupStats.entryCount}</span>
						</div>
						{#if pendingBackupStats.createdAt}
							<div class="flex justify-between text-muted-foreground pt-1 border-t">
								<span>Erstellt am:</span>
								<span>{new Date(pendingBackupStats.createdAt).toLocaleString("de-DE")}</span>
							</div>
						{/if}
					</div>

					{#if !pendingBackupStats.complete}
						<div class="flex items-start gap-2 rounded-lg border border-amber-500/50 bg-amber-500/10 p-3 text-xs text-left">
							<TriangleAlertIcon class="size-4 shrink-0 text-amber-600 mt-0.5" />
							<span class="text-muted-foreground">
								Diese Datei stammt aus einer älteren Version und sagt nicht, ob damals
								schon alle Monate da waren. Prüfe die Liste oben, bevor du ersetzt.
							</span>
						</div>
					{/if}
				{/if}

				<div class="space-y-2">
					<div class="text-xs font-medium text-foreground">Wie soll die Sicherung eingespielt werden?</div>
					<div class="space-y-2">
						<label
							class="flex items-start gap-3 rounded-lg border p-3 cursor-pointer transition-colors {restoreMode === 'merge' ? 'border-primary bg-primary/5' : 'hover:bg-muted/30'}"
						>
							<input
								type="radio"
								name="restoreMode"
								value="merge"
								checked={restoreMode === 'merge'}
								onchange={() => (restoreMode = 'merge')}
								class="mt-0.5 text-primary"
							/>
							<div class="text-xs">
								<span class="font-medium text-foreground block">Zusammenführen (Empfohlen)</span>
								<span class="text-muted-foreground">Fügt fehlende Monate, Einträge und Aktivitäten hinzu. Bestehende neuere Zeiten bleiben erhalten.</span>
							</div>
						</label>

						<label
							class="flex items-start gap-3 rounded-lg border p-3 cursor-pointer transition-colors {restoreMode === 'replace' ? 'border-destructive bg-destructive/5' : 'hover:bg-muted/30'}"
						>
							<input
								type="radio"
								name="restoreMode"
								value="replace"
								checked={restoreMode === 'replace'}
								onchange={() => (restoreMode = 'replace')}
								class="mt-0.5 text-destructive"
							/>
							<div class="text-xs">
								<span class="font-medium text-foreground block">Vollständig ersetzen</span>
								<span class="text-muted-foreground">
									Überschreibt Einstellungen, Aktivitäten und Monate 1:1 mit dem Stand der
									Datei. Monate, die in der Datei fehlen, werden geleert{account.linked
										? " – auch auf deinen anderen Geräten"
										: ""}.
								</span>
							</div>
						</label>
					</div>
				</div>
			</Dialog.Description>
		</Dialog.Header>
		<Dialog.Footer class="gap-2 sm:gap-0">
			<Button variant="outline" disabled={isRestoringBackup} onclick={() => (pendingBackup = null)}>
				Abbrechen
			</Button>
			<Button
				variant={restoreMode === 'replace' ? 'destructive' : 'default'}
				disabled={isRestoringBackup}
				onclick={handleConfirmRestore}
			>
				{#if isRestoringBackup}
					Stelle wieder her…
				{:else}
					{restoreMode === 'replace' ? 'Datenbestand ersetzen' : 'Jetzt zusammenführen'}
				{/if}
			</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>

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

