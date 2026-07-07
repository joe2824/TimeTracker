<script lang="ts">
	import { onMount } from "svelte";
	import { app } from "$lib/app.svelte";
	import { scheduleReminders, scheduleReportReminder, ensureNotificationPermission } from "$lib/reminders";
	import {
		devTriggerIdle,
		devTriggerLongTimer,
		devTriggerReportReminder
	} from "$lib/watchers.svelte";
	import { Button } from "$lib/components/ui/button";
	import { Input } from "$lib/components/ui/input";
	import { Label } from "$lib/components/ui/label";
	import { Switch } from "$lib/components/ui/switch";
	import * as Card from "$lib/components/ui/card";
	import { toast } from "svelte-sonner";
	import { enable, disable, isEnabled } from "@tauri-apps/plugin-autostart";
	import { check, type Update } from "@tauri-apps/plugin-updater";
	import { relaunch } from "@tauri-apps/plugin-process";
	import { getVersion } from "@tauri-apps/api/app";
	import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
	import { openUrl } from "@tauri-apps/plugin-opener";
	import * as Dialog from "$lib/components/ui/dialog";
	import { acceleratorFromEvent, applyShortcuts } from "$lib/shortcuts";
	import Trash2Icon from "@lucide/svelte/icons/trash-2";
	import PlusIcon from "@lucide/svelte/icons/plus";
	import XIcon from "@lucide/svelte/icons/x";
	import ExternalLinkIcon from "@lucide/svelte/icons/external-link";
	import WrenchIcon from "@lucide/svelte/icons/wrench";

	const REPO_URL = "https://github.com/joe2824/TimeTracker";
	let appVersion = $state("");

	// Versteckter Dev-Modus: 10× schnell (≤3 s) aufs Logo tippen.
	let devMode = $state(false);
	let logoTaps: number[] = [];
	function tapLogo() {
		const now = Date.now();
		logoTaps = logoTaps.filter((t) => now - t < 3000);
		logoTaps.push(now);
		if (!devMode && logoTaps.length >= 10) {
			devMode = true;
			logoTaps = [];
			toast.success("Dev-Modus aktiviert");
		}
	}

	async function showFlyout() {
		try {
			const w = await WebviewWindow.getByLabel("tray");
			if (!w) {
				toast.error("Flyout-Fenster nicht gefunden.");
				return;
			}
			await w.show();
			await w.center();
			await w.setAlwaysOnTop(true);
			await w.setFocus();
		} catch (e) {
			toast.error(`Flyout-Fehler: ${e}`, { duration: 60000 });
		}
	}

	let bossEmail = $state(app.settings.bossEmail);
	let senderName = $state(app.settings.senderName);
	let rounding = $state(String(app.settings.rounding));
	let hoursPerDay = $state(String(app.settings.hoursPerDay));
	let subjectTpl = $state(app.settings.reportSubjectTemplate);
	let times = $state<string[]>([...app.settings.reminderTimes]);
	let reportReminder = $state(app.settings.reportReminderEnabled);
	let reportTime = $state(app.settings.reportReminderTime);
	let reportLead = $state(String(app.settings.reportReminderLeadDays));
	let autostart = $state(app.settings.autostart);
	let autoCleanup = $state(app.settings.autoCleanup);

	let idleMin = $state(String(app.settings.idleThresholdMin));
	let maxHours = $state(String(app.settings.maxTimerHours));
	let pomodoroEnabled = $state(app.settings.pomodoroEnabled);
	let pomodoroMin = $state(String(app.settings.pomodoroMin));
	let pomodoroBreakMin = $state(String(app.settings.pomodoroBreakMin));
	let shortcutNotify = $state(app.settings.shortcutNotify);
	let recordingToggle = $state(false);

	async function saveTracking() {
		await app.updateSettings({
			idleThresholdMin: Math.max(0, Number(idleMin) || 0),
			maxTimerHours: Math.max(0, Number(maxHours) || 0),
			pomodoroEnabled,
			pomodoroMin: Math.max(1, Number(pomodoroMin) || 50),
			pomodoroBreakMin: Math.max(0, Number(pomodoroBreakMin) || 0),
			shortcutNotify
		});
		toast.success("Zeiterfassungs-Einstellungen gespeichert.");
	}

	async function onToggleKey(e: KeyboardEvent) {
		if (!recordingToggle) return;
		e.preventDefault();
		if (e.key === "Escape") {
			recordingToggle = false;
			return;
		}
		if (e.key === "Backspace" || e.key === "Delete") {
			await app.updateSettings({ toggleShortcut: "" });
			recordingToggle = false;
			await applyShortcuts();
			return;
		}
		const acc = acceleratorFromEvent(e);
		if (!acc) return;
		await app.updateSettings({ toggleShortcut: acc });
		recordingToggle = false;
		await applyShortcuts();
	}

	async function clearToggle() {
		await app.updateSettings({ toggleShortcut: "" });
		await applyShortcuts();
	}

	onMount(async () => {
		try {
			autostart = await isEnabled();
		} catch (e) {
			toast.error(`Autostart-Status nicht lesbar: ${e}`, { duration: 60000 });
		}
		try {
			appVersion = await getVersion();
		} catch {
			/* nicht-desktop */
		}
	});

	async function saveGeneral() {
		await app.updateSettings({
			bossEmail: bossEmail.trim(),
			senderName: senderName.trim(),
			rounding: Number(rounding),
			hoursPerDay: Number(hoursPerDay) || 7.5,
			reportSubjectTemplate: subjectTpl.trim() || "Stundenerfassung {month} – {name}"
		});
		toast.success("Einstellungen gespeichert.");
	}

	async function saveTimes() {
		const clean = times.map((t) => t.trim()).filter(Boolean);
		await app.updateSettings({
			reminderTimes: clean,
			reportReminderEnabled: reportReminder,
			reportReminderTime: reportTime || "16:00",
			reportReminderLeadDays: Math.max(0, Number(reportLead) || 0)
		});
		scheduleReminders();
		scheduleReportReminder();
		await ensureNotificationPermission();
		toast.success("Erinnerungen aktualisiert.");
	}

	async function toggleAutostart(v: boolean) {
		// autostart ist via bind:checked bereits gesetzt; bei Fehler zuruecksetzen.
		try {
			if (v) await enable();
			else await disable();
			await app.updateSettings({ autostart: v });
		} catch (e) {
			autostart = !v;
			toast.error(`Autostart fehlgeschlagen: ${e}`, { duration: 60000 });
		}
	}

	async function toggleCleanup(v: boolean) {
		await app.updateSettings({ autoCleanup: v });
	}

	let checking = $state(false);
	let pending = $state<Update | null>(null);
	let installing = $state(false);
	let progress = $state(0); // 0..100, -1 = unbestimmt
	let downloaded = $state(0);
	let totalBytes = $state(0);

	async function checkUpdate() {
		checking = true;
		try {
			const update = await check();
			if (update) {
				pending = update;
			} else {
				toast.success("Du bist auf dem neuesten Stand.");
			}
		} catch (e) {
			toast.error(`Update-Prüfung nicht möglich: ${e}`);
		} finally {
			checking = false;
		}
	}

	async function installUpdate() {
		if (!pending) return;
		installing = true;
		progress = -1;
		downloaded = 0;
		totalBytes = 0;
		try {
			await pending.downloadAndInstall((event) => {
				if (event.event === "Started") {
					totalBytes = event.data.contentLength ?? 0;
					progress = totalBytes ? 0 : -1;
				} else if (event.event === "Progress") {
					downloaded += event.data.chunkLength;
					if (totalBytes) progress = Math.round((downloaded / totalBytes) * 100);
				} else if (event.event === "Finished") {
					progress = 100;
				}
			});
			toast.success("Update installiert – App wird neu gestartet.");
			await relaunch();
		} catch (e) {
			toast.error(`Update fehlgeschlagen: ${e}`, { duration: 60000 });
			installing = false;
		}
	}
</script>

<div class="grid gap-4 lg:grid-cols-2">
	<Card.Root>
		<Card.Header><Card.Title>Bericht & E-Mail</Card.Title></Card.Header>
		<Card.Content class="space-y-3">
			<div class="space-y-1">
				<Label for="boss">E-Mail des Chefs</Label>
				<Input id="boss" type="email" bind:value={bossEmail} placeholder="chef@firma.de" />
			</div>
			<div class="space-y-1">
				<Label for="sender">Dein Name (optional)</Label>
				<Input id="sender" bind:value={senderName} />
			</div>
			<div class="space-y-1">
				<Label for="subj">Betreff-Vorlage</Label>
				<Input id="subj" bind:value={subjectTpl} />
				<p class="text-muted-foreground text-xs">
					{"{month}"} = Monat, {"{name}"} = dein Name
				</p>
			</div>
			<div class="grid grid-cols-2 gap-2">
				<div class="space-y-1">
					<Label for="round">Rundung</Label>
					<select
						id="round"
						bind:value={rounding}
						class="border-input bg-background h-9 w-full rounded-md border px-3 text-sm"
					>
						<option value="0.25">Viertelstunde (0,25 h)</option>
						<option value="0.5">Halbe Stunde (0,5 h)</option>
						<option value="1">Volle Stunde (1 h)</option>
					</select>
				</div>
				<div class="space-y-1">
					<Label for="hpd">Stunden / Arbeitstag</Label>
					<Input id="hpd" type="number" step="0.25" min="1" max="24" bind:value={hoursPerDay} />
					<p class="text-muted-foreground text-xs">Für Urlaub/Abwesenheit: ganzer Tag = dieser Wert.</p>
				</div>
			</div>
			<Button onclick={saveGeneral}>Speichern</Button>
		</Card.Content>
	</Card.Root>

	<Card.Root>
		<Card.Header><Card.Title>Erinnerungen</Card.Title></Card.Header>
		<Card.Content class="space-y-3">
			<p class="text-muted-foreground text-sm">
				Zu diesen Uhrzeiten erinnert dich die App, deine Zeiten einzutragen.
			</p>
			{#each times as _, i (i)}
				<div class="flex gap-2">
					<Input type="time" bind:value={times[i]} />
					<Button variant="ghost" size="icon" onclick={() => (times = times.filter((_, j) => j !== i))}>
						<Trash2Icon class="size-4" />
					</Button>
				</div>
			{/each}
			<div class="flex gap-2">
				<Button variant="outline" size="sm" onclick={() => (times = [...times, "14:00"])}>
					<PlusIcon class="size-4" /> Uhrzeit
				</Button>
			</div>

			<div class="space-y-2 border-t pt-3">
				<div class="flex items-center justify-between space-x-2">
					<Label for="reprem" class="flex flex-col items-start gap-1">
						<span class="text-sm font-medium">Monatlicher Bericht-Hinweis</span>
						<span class="text-muted-foreground text-xs font-normal">
							Am letzten Werktag erinnern, den Bericht zu senden.
						</span>
					</Label>
					<Switch id="reprem" bind:checked={reportReminder} />
				</div>
				{#if reportReminder}
					<div class="grid grid-cols-2 gap-2">
						<div class="space-y-1">
							<Label for="replead">Werktage vorher</Label>
							<Input id="replead" type="number" min="0" max="10" bind:value={reportLead} />
							<p class="text-muted-foreground text-xs">0 = letzter Werktag.</p>
						</div>
						<div class="space-y-1">
							<Label for="reptime">Uhrzeit</Label>
							<Input id="reptime" type="time" bind:value={reportTime} />
						</div>
					</div>
				{/if}
			</div>

			<Button size="sm" onclick={saveTimes}>Erinnerungen speichern</Button>
		</Card.Content>
	</Card.Root>

	<Card.Root>
		<Card.Header>
			<Card.Title>Zeiterfassung</Card.Title>
			<Card.Description>Verhalten von Timer, Hinweisen und Hotkey.</Card.Description>
		</Card.Header>
		<Card.Content class="space-y-4">
			<div class="grid gap-4 sm:grid-cols-2">
				<div class="space-y-1">
					<Label for="idle">Leerlauf nachfragen ab (Min, 0 = aus)</Label>
					<Input id="idle" type="number" min="0" bind:value={idleMin} />
				</div>
				<div class="space-y-1">
					<Label for="maxh">Auto-Stop-Warnung ab (Std, 0 = aus)</Label>
					<Input id="maxh" type="number" min="0" bind:value={maxHours} />
				</div>
			</div>

			<div class="flex items-center justify-between space-x-2">
				<Label for="scnotify" class="flex flex-col items-start gap-1">
					<span class="text-sm font-medium">Hinweis bei Shortcut-Start/Stop</span>
					<span class="text-muted-foreground text-xs font-normal">Kurze Meldung, verschwindet selbst.</span>
				</Label>
				<Switch id="scnotify" bind:checked={shortcutNotify} />
			</div>

			<div class="flex items-center justify-between space-x-2">
				<Label for="pomo" class="flex flex-col items-start gap-1">
					<span class="text-sm font-medium">Pomodoro</span>
					<span class="text-muted-foreground text-xs font-normal">
						Fokus-/Pausen-Zyklus mit Hinweisen (optional).
					</span>
				</Label>
				<Switch id="pomo" bind:checked={pomodoroEnabled} />
			</div>
			{#if pomodoroEnabled}
				<div class="grid grid-cols-2 gap-2">
					<div class="space-y-1">
						<Label for="pomomin">Fokus (Min)</Label>
						<Input id="pomomin" type="number" min="1" bind:value={pomodoroMin} />
					</div>
					<div class="space-y-1">
						<Label for="pomobreak">Pause (Min, 0 = aus)</Label>
						<Input id="pomobreak" type="number" min="0" bind:value={pomodoroBreakMin} />
					</div>
				</div>
			{/if}

			<div class="space-y-1">
				<Label>Globaler Start/Stop-Hotkey (letzter Timer)</Label>
				<div class="flex items-center gap-2">
					{#if recordingToggle}
						<span class="text-muted-foreground text-sm italic">Taste drücken… (Esc=Abbruch)</span>
					{:else}
						<button
							class="border-input bg-muted hover:bg-accent cursor-pointer rounded border px-2 py-1 font-mono text-xs"
							onclick={() => (recordingToggle = true)}
						>
							{app.settings.toggleShortcut || "Festlegen…"}
						</button>
						{#if app.settings.toggleShortcut}
							<Button variant="ghost" size="icon" class="size-7" onclick={clearToggle} title="Entfernen">
								<XIcon class="size-3.5" />
							</Button>
						{/if}
					{/if}
				</div>
			</div>

			<Button size="sm" onclick={saveTracking}>Speichern</Button>
		</Card.Content>
	</Card.Root>

	<Card.Root>
		<Card.Header><Card.Title>System</Card.Title></Card.Header>
		<Card.Content class="space-y-4">
			<div class="flex items-center justify-between space-x-2">
				<Label for="autostart" class="flex flex-col items-start gap-1">
					<span class="text-sm font-medium">Mit Windows starten</span>
					<span class="text-muted-foreground text-xs font-normal">App läuft im Hintergrund (Tray).</span>
				</Label>
				<Switch id="autostart" bind:checked={autostart} onCheckedChange={toggleAutostart} />
			</div>
			<div class="flex items-center justify-between space-x-2">
				<Label for="autocleanup" class="flex flex-col items-start gap-1">
					<span class="text-sm font-medium">Alte Monate automatisch löschen</span>
					<span class="text-muted-foreground text-xs font-normal">Monatsdateien älter als 12 Monate.</span>
				</Label>
				<Switch id="autocleanup" bind:checked={autoCleanup} onCheckedChange={toggleCleanup} />
			</div>
			<Button variant="outline" onclick={checkUpdate} disabled={checking}>
				{checking ? "Suche…" : "Nach Updates suchen"}
			</Button>
		</Card.Content>
	</Card.Root>

	<Card.Root>
		<Card.Header><Card.Title>Über</Card.Title></Card.Header>
		<Card.Content class="space-y-3">
			<div class="flex items-center gap-3">
				<button type="button" class="cursor-pointer" onclick={tapLogo} aria-label="TimeTracker">
					<img src="/logo.svg" alt="TimeTracker" class="h-10 w-auto" />
				</button>
				<div>
					<div class="flex items-center gap-1.5">
						<span class="text-sm font-medium">TimeTracker</span>
						{#if devMode}
							<span
								class="bg-primary/10 text-primary inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium"
								title="Dev-Modus aktiv"
							>
								<WrenchIcon class="size-3" /> Dev
							</span>
						{/if}
					</div>
					<div class="text-muted-foreground text-xs">Version {appVersion || "—"}</div>
				</div>
			</div>
			<div class="flex flex-wrap gap-2">
				<Button variant="outline" size="sm" onclick={() => openUrl(REPO_URL)}>
					<ExternalLinkIcon class="size-4" /> GitHub
				</Button>
			</div>
			<p class="text-muted-foreground text-xs">
				Zeiterfassung für Projektzeiten mit Monatsbericht.
			</p>

			{#if devMode}
				<div class="border-t pt-3">
					<div class="text-muted-foreground mb-2 text-xs font-medium">Dev</div>
					<div class="flex flex-wrap gap-2">
						<Button variant="secondary" size="sm" onclick={showFlyout}>Tray-Flyout anzeigen</Button>
					</div>
					<div class="text-muted-foreground mt-3 mb-1.5 text-xs">Modals öffnen</div>
					<div class="flex flex-wrap gap-2">
						<Button variant="secondary" size="sm" onclick={() => app.openOnboarding()}>
							Willkommensbildschirm
						</Button>
						<Button variant="secondary" size="sm" onclick={devTriggerLongTimer}>
							Langzeit-Timer
						</Button>
						<Button variant="secondary" size="sm" onclick={devTriggerIdle}>Leerlauf</Button>
						<Button variant="secondary" size="sm" onclick={devTriggerReportReminder}>
							Berichts-Erinnerung
						</Button>
					</div>
				</div>
			{/if}
		</Card.Content>
	</Card.Root>
</div>

<Dialog.Root
	open={!!pending}
	onOpenChange={(v) => {
		if (!v && !installing) pending = null;
	}}
>
	<Dialog.Content class="sm:max-w-md">
		<Dialog.Header>
			<Dialog.Title>Update verfügbar</Dialog.Title>
			<Dialog.Description>
				Version {pending?.version}
				{#if pending?.date}· {pending.date.split(" ")[0]}{/if}
			</Dialog.Description>
		</Dialog.Header>

		{#if pending?.body}
			<div class="text-muted-foreground max-h-40 overflow-y-auto whitespace-pre-wrap text-sm">
				{pending.body}
			</div>
		{/if}

		{#if installing}
			<div class="space-y-1">
				<div class="bg-muted h-2 w-full overflow-hidden rounded">
					<div
						class="bg-primary h-full transition-all"
						style={`width:${progress < 0 ? 100 : progress}%`}
						class:animate-pulse={progress < 0}
					></div>
				</div>
				<p class="text-muted-foreground text-xs">
					{#if progress < 0}
						Lädt…
					{:else}
						{progress}%{#if totalBytes}
							· {(downloaded / 1e6).toFixed(1)} / {(totalBytes / 1e6).toFixed(1)} MB{/if}
					{/if}
				</p>
			</div>
		{/if}

		<Dialog.Footer>
			<Button variant="outline" disabled={installing} onclick={() => (pending = null)}>Später</Button>
			<Button disabled={installing} onclick={installUpdate}>
				{installing ? "Installiere…" : "Jetzt installieren"}
			</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>

<svelte:window onkeydown={onToggleKey} />
