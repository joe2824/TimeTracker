<script lang="ts">
	import { onMount } from "svelte";
	import { app } from "$lib/app.svelte";
	import { listEntryYears, type StoredYear } from "$lib/store";
	import { scheduleReminders, scheduleReportReminder, ensureNotificationPermission } from "$lib/reminders";
	import {
		devTriggerIdle,
		devTriggerLongTimer,
		devTriggerReportReminder
	} from "$lib/watchers.svelte";
	import { clockToMin, minToClock } from "$lib/time";
	import { Button } from "$lib/components/ui/button";
	import { Input } from "$lib/components/ui/input";
	import WorkdayPicker from "$lib/components/WorkdayPicker.svelte";
	import { Label } from "$lib/components/ui/label";
	import SettingToggle from "$lib/components/SettingToggle.svelte";
	import * as Select from "$lib/components/ui/select";
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
	import ShortcutKey from "$lib/components/ShortcutKey.svelte";
	import SavedHint from "$lib/components/SavedHint.svelte";
	import SettingRow from "$lib/components/SettingRow.svelte";

	const REPO_URL = "https://github.com/joe2824/TimeTracker";

	/** Rundungsstufen des Berichts: Wert (Stunden) -> Beschriftung. */
	const ROUNDINGS: Record<string, string> = {
		"0.25": "Viertelstunde (0:15)",
		"0.5": "Halbe Stunde (0:30)",
		"1": "Volle Stunde (1:00)"
	};
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
	// Als Uhrzeit ("HH:MM") statt Dezimalstunden eingeben.
	let hoursPerDay = $state(minToClock(app.settings.hoursPerDay * 60));
	let workdays = $state([...app.settings.workdays]);
	let subjectTpl = $state(app.settings.reportSubjectTemplate);
	let statsEnabled = $state(app.settings.statsEnabled);
	let times = $state<string[]>([...app.settings.reminderTimes]);
	let reportReminder = $state(app.settings.reportReminderEnabled);
	let reportTime = $state(app.settings.reportReminderTime);
	let reportLead = $state(String(app.settings.reportReminderLeadDays));
	let autostart = $state(app.settings.autostart);

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
		savedTracking = Date.now();
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

	// ---- Automatisches Speichern ----
	// Kein Speichern-Button: Autostart und Hotkey mussten ohnehin sofort wirken
	// (OS-API bzw. globale Registrierung), zwei gleich aussehende Schalter mit
	// zwei Verhalten waren der Bruch. Statt Toast je Aenderung ein kurzer Hinweis
	// an der Card – ein Toast pro Tastendruck waere Laerm.
	// Je Card ein eigener Zeitstempel UND eine eigene Speicherfunktion: eine
	// gemeinsame haette den Hinweis auch auf der Card blinken lassen, die man gar
	// nicht angefasst hat.
	let savedReport = $state(0);
	let savedWorktime = $state(0);
	let savedTimes = $state(0);
	let savedTracking = $state(0);
	let savedSystem = $state(0);

	/**
	 * Leeres Feld auf den gespeicherten Wert zuruecksetzen, sonst den getrimmten
	 * nehmen. Liefert immer einen gueltigen Wert.
	 *
	 * Ohne Speichern-Button ist das Pflicht: `x || default` schriebe beim Leeren des
	 * Feldes still den Default fort – wer eine Vorlage zum Neutippen leert, haette
	 * sie damit auf den Standardtext gesetzt. Zurueckgesetzt wird nur das eine Feld;
	 * die uebrigen der Card werden trotzdem gespeichert.
	 */
	function orStored(raw: string, stored: string): string {
		return raw.trim() || stored;
	}

	async function saveReport() {
		subjectTpl = orStored(subjectTpl, app.settings.reportSubjectTemplate);
		await app.updateSettings({
			bossEmail: bossEmail.trim(),
			senderName: senderName.trim(),
			reportSubjectTemplate: subjectTpl,
			statsEnabled
		});
		savedReport = Date.now();
	}

	async function saveWorktime() {
		// Normalisieren statt aussteigen: ein leeres Stunden-Feld darf nicht das
		// Speichern von Rundung und Arbeitstagen verhindern.
		const min = clockToMin(hoursPerDay) ?? 0;
		const valid = min > 0 ? min : app.settings.hoursPerDay * 60;
		hoursPerDay = minToClock(valid);
		await app.updateSettings({
			rounding: Number(rounding),
			hoursPerDay: valid / 60,
			workdays: [...workdays].sort((a, b) => a - b)
		});
		savedWorktime = Date.now();
	}

	/** Fokusdauer uebernehmen; leeres Feld haette sonst still 50 fortgeschrieben. */
	function commitPomodoroMin() {
		pomodoroMin = orStored(pomodoroMin, String(app.settings.pomodoroMin));
		void saveTracking();
	}

	async function saveTimes() {
		reportTime = orStored(reportTime, app.settings.reportReminderTime);
		const clean = times.map((t) => t.trim()).filter(Boolean);
		await app.updateSettings({
			reminderTimes: clean,
			reportReminderEnabled: reportReminder,
			reportReminderTime: reportTime,
			reportReminderLeadDays: Math.max(0, Number(reportLead) || 0)
		});
		scheduleReminders();
		scheduleReportReminder();
		// Nur fragen, wenn ueberhaupt etwas benachrichtigen soll – beim Abschalten
		// nach der Erlaubnis zu fragen waere verkehrt herum.
		if (clean.length > 0 || reportReminder) await ensureNotificationPermission();
		savedTimes = Date.now();
	}

	async function toggleAutostart(v: boolean) {
		// autostart ist via bind:checked bereits gesetzt; bei Fehler zuruecksetzen.
		try {
			if (v) await enable();
			else await disable();
			await app.updateSettings({ autostart: v });
			savedSystem = Date.now();
		} catch (e) {
			autostart = !v;
			toast.error(`Autostart fehlgeschlagen: ${e}`, { duration: 60000 });
		}
	}

	// ---- Daten: ganze Jahre loeschen ----
	let years = $state<StoredYear[]>([]);
	let yearToDelete = $state<StoredYear | null>(null);
	let deleting = $state(false);

	async function refreshYears() {
		years = await listEntryYears();
	}
	onMount(refreshYears);

	async function confirmDeleteYear() {
		const target = yearToDelete;
		if (!target) return;
		deleting = true;
		try {
			const months = await app.deleteYearEntries(target.year);
			await refreshYears();
			toast.success(`${target.year} gelöscht (${months} Monatsdatei${months === 1 ? "" : "en"}).`);
			yearToDelete = null;
		} catch (e) {
			toast.error(`Löschen fehlgeschlagen: ${e}`);
		} finally {
			deleting = false;
		}
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
		<Card.Header>
			<Card.Title>Bericht & E-Mail</Card.Title>
			<Card.Action><SavedHint at={savedReport} /></Card.Action>
		</Card.Header>
		<Card.Content class="space-y-3">
			<div class="space-y-1">
				<Label for="boss">E-Mail des Chefs</Label>
				<Input id="boss" type="email" bind:value={bossEmail} placeholder="chef@firma.de" onchange={saveReport} />
			</div>
			<div class="space-y-1">
				<Label for="sender">Dein Name (optional)</Label>
				<Input id="sender" bind:value={senderName} onchange={saveReport} />
			</div>
			<div class="space-y-1">
				<Label for="subj">Betreff-Vorlage</Label>
				<Input id="subj" bind:value={subjectTpl} onchange={saveReport} />
				<p class="text-muted-foreground text-xs">
					{"{month}"} = Monat, {"{name}"} = dein Name
				</p>
			</div>
			<SettingToggle
				id="stats"
				title="Auswertung anzeigen"
				description="Saldo, Stunden je Aktivität und Jahres-Heatmap im Tab „Bericht“. Nur für dich – die E-Mail bleibt unverändert."
				bind:checked={statsEnabled}
				onCheckedChange={() => saveReport()}
				class="border-t pt-3"
			/>
		</Card.Content>
	</Card.Root>

	<Card.Root>
		<Card.Header>
			<Card.Title>Erinnerungen</Card.Title>
			<Card.Action><SavedHint at={savedTimes} /></Card.Action>
		</Card.Header>
		<Card.Content class="space-y-3">
			<p class="text-muted-foreground text-sm">
				Zu diesen Uhrzeiten erinnert dich die App, deine Zeiten einzutragen.
			</p>
			{#each times as _, i (i)}
				<div class="flex gap-2">
					<Input type="time" bind:value={times[i]} onchange={saveTimes} />
					<Button
						variant="ghost"
						size="icon"
						title="Uhrzeit entfernen"
						onclick={() => {
							times = times.filter((_, j) => j !== i);
							void saveTimes();
						}}
					>
						<Trash2Icon class="size-4" />
					</Button>
				</div>
			{/each}
			<div class="flex gap-2">
				<Button
					variant="outline"
					size="sm"
					onclick={() => {
						times = [...times, "14:00"];
						// Ohne Speichern-Button muss das Anlegen selbst persistieren – sonst
						// stuende die neue Zeit nur im Fenster und waere beim Neustart weg.
						void saveTimes();
					}}
				>
					<PlusIcon class="size-4" /> Uhrzeit
				</Button>
			</div>

			<div class="space-y-2 border-t pt-3">
				<SettingToggle
					id="reprem"
					title="Monatlicher Bericht-Hinweis"
					description="Am letzten Werktag erinnern, den Bericht zu senden."
					bind:checked={reportReminder}
					onCheckedChange={() => saveTimes()}
				/>
				{#if reportReminder}
					<SettingRow id="replead" title="Werktage vorher" description="0 = letzter Werktag.">
						{#snippet control()}
							<Input
								id="replead"
								type="number"
								min="0"
								max="10"
								class="w-24"
								bind:value={reportLead}
								onchange={saveTimes}
							/>
						{/snippet}
					</SettingRow>
					<SettingRow id="reptime" title="Uhrzeit" description="Wann an diesem Tag erinnert wird.">
						{#snippet control()}
							<Input id="reptime" type="time" class="w-32" bind:value={reportTime} onchange={saveTimes} />
						{/snippet}
					</SettingRow>
				{/if}
			</div>

		</Card.Content>
	</Card.Root>

	<Card.Root>
		<Card.Header>
			<Card.Title>Arbeitszeit</Card.Title>
			<Card.Description>Arbeitstage & -zeit – Basis für Abwesenheiten und Bericht.</Card.Description>
			<Card.Action><SavedHint at={savedWorktime} /></Card.Action>
		</Card.Header>
		<Card.Content class="space-y-3">
			<div class="space-y-1">
				<Label>An welchen Tagen arbeitest du?</Label>
				<WorkdayPicker bind:value={workdays} onchange={saveWorktime} />
				<p class="text-muted-foreground text-xs">
					Nicht-Arbeitstage (z.&nbsp;B. Wochenende) werden beim Kalender-Import und bei
					Abwesenheits-Zeiträumen übersprungen und tauchen nicht im Bericht auf.
				</p>
			</div>
			<SettingRow
				id="hpd"
				title="Stunden / Arbeitstag"
				description="Als Uhrzeit, z. B. 07:30. Ganzer Abwesenheitstag = dieser Wert."
				class="border-t pt-3"
			>
				{#snippet control()}
					<Input id="hpd" type="time" class="w-32" bind:value={hoursPerDay} onchange={saveWorktime} />
				{/snippet}
			</SettingRow>
			<SettingRow id="round" title="Rundung" description="Stunden je Aktivität im Bericht.">
				{#snippet control()}
					<Select.Root type="single" bind:value={rounding} onValueChange={() => saveWorktime()}>
						<Select.Trigger id="round" class="w-48">{ROUNDINGS[rounding] ?? rounding}</Select.Trigger>
						<Select.Content>
							{#each Object.entries(ROUNDINGS) as [v, label] (v)}
								<Select.Item value={v} {label}>{label}</Select.Item>
							{/each}
						</Select.Content>
					</Select.Root>
				{/snippet}
			</SettingRow>
		</Card.Content>
	</Card.Root>

	<Card.Root>
		<Card.Header>
			<Card.Title>Zeiterfassung</Card.Title>
			<Card.Description>Verhalten von Timer, Hinweisen und Hotkey.</Card.Description>
			<Card.Action><SavedHint at={savedTracking} /></Card.Action>
		</Card.Header>
		<Card.Content class="space-y-4">
			<!-- Ein Rhythmus wie bei den Schaltern darunter: Titel links, Feld rechts.
			     Vorher ein 2er-Grid mit überlangen Labels („… (Min, 0 = aus)“) – die
			     Hinweise stehen jetzt in der Erklärungszeile, wo sie hingehören. -->
			<SettingRow
				id="idle"
				title="Leerlauf nachfragen ab"
				description="Nach so vielen Minuten ohne Eingabe nachfragen. 0 = aus."
			>
				{#snippet control()}
					<Input id="idle" type="number" min="0" class="w-24" bind:value={idleMin} onchange={saveTracking} />
				{/snippet}
			</SettingRow>

			<SettingRow
				id="maxh"
				title="Auto-Stop-Warnung ab"
				description="Warnen, wenn ein Timer länger als so viele Stunden läuft. 0 = aus."
			>
				{#snippet control()}
					<Input id="maxh" type="number" min="0" class="w-24" bind:value={maxHours} onchange={saveTracking} />
				{/snippet}
			</SettingRow>

			<SettingToggle
				id="scnotify"
				title="Hinweis bei Shortcut-Start/Stop"
				description="Kurze Meldung, verschwindet selbst."
				bind:checked={shortcutNotify}
				onCheckedChange={() => saveTracking()}
			/>

			<SettingToggle
				id="pomo"
				title="Pomodoro"
				description="Fokus-/Pausen-Zyklus mit Hinweisen (optional)."
				bind:checked={pomodoroEnabled}
				onCheckedChange={() => saveTracking()}
			/>
			{#if pomodoroEnabled}
				<div class="grid grid-cols-2 gap-2">
					<div class="space-y-1">
						<Label for="pomomin">Fokus (Min)</Label>
						<Input id="pomomin" type="number" min="1" bind:value={pomodoroMin} onchange={commitPomodoroMin} />
					</div>
					<div class="space-y-1">
						<Label for="pomobreak">Pause (Min, 0 = aus)</Label>
						<Input id="pomobreak" type="number" min="0" bind:value={pomodoroBreakMin} onchange={saveTracking} />
					</div>
				</div>
			{/if}

			<SettingRow
				title="Globaler Start/Stop-Hotkey"
				description="Startet/stoppt den zuletzt benutzten Timer – auch wenn die App im Hintergrund ist."
			>
				{#snippet control()}
					<div class="flex items-center gap-1">
						{#if recordingToggle}
							<span class="text-muted-foreground text-sm italic">Taste drücken… (Esc=Abbruch)</span>
						{:else if app.settings.toggleShortcut}
							<ShortcutKey
								shortcut={app.settings.toggleShortcut}
								onclick={() => (recordingToggle = true)}
							/>
							<Button variant="ghost" size="icon-sm" onclick={clearToggle} title="Entfernen">
								<XIcon />
							</Button>
						{:else}
							<!-- Festlegen ist eine Aktion, keine Taste – also ein normaler Button
							     statt der Keycap-Optik, die es vorher trug. -->
							<Button variant="outline" size="sm" onclick={() => (recordingToggle = true)}>
								Festlegen…
							</Button>
						{/if}
					</div>
				{/snippet}
			</SettingRow>

		</Card.Content>
	</Card.Root>

	<Card.Root>
		<Card.Header>
			<Card.Title>System</Card.Title>
			<Card.Action><SavedHint at={savedSystem} /></Card.Action>
		</Card.Header>
		<Card.Content class="space-y-4">
			<SettingToggle
				id="autostart"
				title="Mit Windows starten"
				description="App läuft im Hintergrund (Tray)."
				bind:checked={autostart}
				onCheckedChange={toggleAutostart}
			/>
			<Button variant="outline" onclick={checkUpdate} disabled={checking}>
				{checking ? "Suche…" : "Nach Updates suchen"}
			</Button>
		</Card.Content>
	</Card.Root>

	<Card.Root>
		<Card.Header>
			<Card.Title>Daten</Card.Title>
			<Card.Description>
				Erfasste Zeiten bleiben liegen, bis du sie löschst. Es wird nichts automatisch entfernt.
			</Card.Description>
		</Card.Header>
		<Card.Content class="space-y-3">
			{#if years.length === 0}
				<p class="text-muted-foreground text-sm">Noch keine erfassten Zeiten.</p>
			{:else}
				{#each years as y (y.year)}
					<div class="flex items-center justify-between gap-3 border-b pb-2 last:border-0">
						<div>
							<div class="text-sm font-medium">{y.year}</div>
							<div class="text-muted-foreground text-xs">
								{y.months} Monat{y.months === 1 ? "" : "e"} · {y.entries} Eintr{y.entries === 1
									? "ag"
									: "äge"}
							</div>
						</div>
						<Button variant="outline" size="sm" onclick={() => (yearToDelete = y)}>
							<Trash2Icon class="size-4" /> Löschen
						</Button>
					</div>
				{/each}
			{/if}
		</Card.Content>
	</Card.Root>

	<Card.Root>
		<Card.Header><Card.Title>Über</Card.Title></Card.Header>
		<Card.Content class="space-y-3">
			<div class="flex items-center gap-3">
				<button type="button" class="cursor-none" onclick={tapLogo} aria-label="TimeTracker">
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

<!-- Loeschen ist endgueltig: kein Papierkorb, kein Backup. Deshalb wird vorher
     genannt, was genau verschwindet. -->
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
			<Button variant="outline" disabled={deleting} onclick={() => (yearToDelete = null)}>
				Abbrechen
			</Button>
			<Button disabled={deleting} onclick={confirmDeleteYear}>
				{deleting ? "Lösche…" : `${yearToDelete?.year} endgültig löschen`}
			</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>

<svelte:window onkeydown={onToggleKey} />
