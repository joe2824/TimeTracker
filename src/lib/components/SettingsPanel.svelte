<script lang="ts">
	import { onMount } from "svelte";
	import { cn } from "$lib/utils";
	import { app } from "$lib/app.svelte";
	import { listEntryYears, type StoredYear } from "$lib/store";
	import { scheduleReminders, scheduleReportReminder, ensureNotificationPermission } from "$lib/reminders";
	import {
		devTriggerIdle,
		devTriggerLongTimer,
		devTriggerReportReminder
	} from "$lib/watchers.svelte";
	import { formFromSettings, patchFrom, syncForm } from "$lib/settingsSync";
	import type { Settings } from "$lib/types";
	import { Button } from "$lib/components/ui/button";
	import { Input } from "$lib/components/ui/input";
	import WorkdayPicker from "$lib/components/WorkdayPicker.svelte";
	import { Label } from "$lib/components/ui/label";
	import SettingToggle from "$lib/components/SettingToggle.svelte";
	import * as Select from "$lib/components/ui/select";
	import { toast } from "svelte-sonner";
	import { capabilities, isTauri } from "$lib/platform/env";
	import { enable, disable, isEnabled } from "@tauri-apps/plugin-autostart";
	import { checkForUpdate, updater } from "$lib/updater.svelte";
	import { getVersion } from "@tauri-apps/api/app";
	import { invoke } from "@tauri-apps/api/core";
	import { relaunch } from "@tauri-apps/plugin-process";
	import { errorText, flushLog, logInfo } from "$lib/log";
	import { openExternal } from "$lib/platform/open";
	import * as Dialog from "$lib/components/ui/dialog";
	import { acceleratorFromEvent, applyShortcuts } from "$lib/shortcuts";
	import Trash2Icon from "@lucide/svelte/icons/trash-2";
	import PlusIcon from "@lucide/svelte/icons/plus";
	import XIcon from "@lucide/svelte/icons/x";
	import ExternalLinkIcon from "@lucide/svelte/icons/external-link";
	import TimerIcon from "@lucide/svelte/icons/timer";
	import FileTextIcon from "@lucide/svelte/icons/file-text";
	import BellIcon from "@lucide/svelte/icons/bell";
	import UserRoundIcon from "@lucide/svelte/icons/user-round";
	import ShieldCheckIcon from "@lucide/svelte/icons/shield-check";
	import MonitorCogIcon from "@lucide/svelte/icons/monitor-cog";
	import InfoIcon from "@lucide/svelte/icons/info";
	import WrenchIcon from "@lucide/svelte/icons/wrench";
	import ShortcutKey from "$lib/components/ShortcutKey.svelte";
	import SettingRow from "$lib/components/SettingRow.svelte";
	import SettingsCard from "$lib/components/SettingsCard.svelte";
	import AccountPanel from "$lib/components/AccountPanel.svelte";
	import AdminPanel from "$lib/components/AdminPanel.svelte";
	import PasskeyPanel from "$lib/components/PasskeyPanel.svelte";
	import DangerZonePanel from "$lib/components/DangerZonePanel.svelte";
	import LogPanel from "$lib/components/LogPanel.svelte";
	import { account } from "$lib/sync/account.svelte";
	import { APP_VERSION } from "$lib/defaults";

	const REPO_URL = "https://github.com/joe2824/TimeTracker";

	onMount(() => {
		void account.accountInfo().catch(() => {});
	});

	/** Rundungsstufen des Berichts: Wert (Stunden) -> Beschriftung. */
	const ROUNDINGS: Record<string, string> = {
		"0.25": "Viertelstunde (0:15)",
		"0.5": "Halbe Stunde (0:30)",
		"1": "Volle Stunde (1:00)"
	};
	let appVersion = $state(APP_VERSION);

	// Versteckter Dev-Modus: 10× schnell (≤3 s) aufs Logo tippen.
	// Der Schalter selbst liegt im App-Zustand, damit er das Vorfuehren des
	// Ladebildschirms ueberlebt – dabei wird diese Seite kurz abgebaut.
	let logoTaps: number[] = [];
	function tapLogo() {
		const now = Date.now();
		logoTaps = logoTaps.filter((t) => now - t < 3000);
		logoTaps.push(now);
		if (!app.devMode && logoTaps.length >= 10) {
			app.devMode = true;
			logoTaps = [];
			toast.success("Dev-Modus aktiviert");
		}
	}

	/** Dev: Flyout ueber denselben Weg oeffnen wie ein Klick aufs Tray-Icon. */
	async function showFlyout() {
		try {
			await invoke("show_flyout");
		} catch (e) {
			toast.error(`Flyout-Fehler: ${errorText(e)}`, { duration: 60000 });
		}
	}

	/** Arbeitskopie aller Einstellungen dieser Seite. */
	let form = $state(formFromSettings(current()));
	let recordingToggle = $state(false);

	/** Der gespeicherte Stand als schlichte Kopie (ohne Svelte-Proxy). */
	function current(): Settings {
		return $state.snapshot(app.settings) as Settings;
	}

	/** Zuletzt uebernommener Stand der Einstellungen. */
	let synced = current();

	/** Haelt die Kopie synchron, wenn andere Stellen (Assistent, Tray-Fenster) die Einstellungen aendern. */
	$effect(() => {
		synced = syncForm(form, synced, current());
	});

	async function saveTracking() {
		await save(TRACKING_KEYS);
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
		// Autostart-Plugin gibt es nur auf dem Desktop.
		if (capabilities.autostart) {
			try {
				form.autostart = await isEnabled();
			} catch (e) {
				toast.error(`Autostart-Status nicht lesbar: ${e}`, { duration: 60000 });
			}
		}
		try {
			appVersion = await getVersion();
		} catch {
			/* nicht-desktop */
		}
	});

	// ---- Automatisches Speichern ----
	// Kein Speichern-Button, statt Toast je Aenderung nur ein kurzer Hinweis an
	// der Card. Eigener Zeitstempel je Card, sonst blinkt der Hinweis auch auf
	// einer Card, die man gar nicht angefasst hat.
	let savedReport = $state(0);
	let savedWorktime = $state(0);
	let savedTimes = $state(0);
	let savedTracking = $state(0);
	let savedSystem = $state(0);
	let savedBoss = $state(0);

	// Welche Einstellungen zu welcher Card gehoeren; Umrechnung und Rueckfallwerte
	// stecken in settingsSync.ts.
	const REPORT_KEYS = [
		"bossEmail",
		"senderName",
		"reportSubjectTemplate",
		"statsEnabled",
		"arbzgEnabled",
		"arbzgTrackingHint"
	] as const;
	const TIMES_KEYS = [
		"reminderTimes",
		"reportReminderEnabled",
		"reportReminderTime",
		"reportReminderLeadDays"
	] as const;
	const WORKTIME_KEYS = ["rounding", "hoursPerDay", "breakDeduction", "workdays"] as const;
	const TRACKING_KEYS = [
		"idleThresholdMin",
		"maxTimerHours",
		"pomodoroEnabled",
		"pomodoroMin",
		"pomodoroBreakMin",
		"shortcutNotify"
	] as const;
	const BOSS_KEYS = ["bossMode", "team", "teamSubjectFilter", "teamScanSubfolders"] as const;

	/** Die genannten Felder der Arbeitskopie speichern. */
	async function save(keys: readonly (keyof Settings)[]): Promise<void> {
		await app.updateSettings(patchFrom(form, keys, current()));
	}

	async function saveReport() {
		await save(REPORT_KEYS);
		savedReport = Date.now();
		if (form.senderName.trim()) {
			void account.updateDisplayName(form.senderName.trim());
		}
	}

	async function saveErrorReports() {
		await save(["errorReportsEnabled"]);
	}

	async function saveBossMode() {
		await save(BOSS_KEYS);
		savedBoss = Date.now();
	}

	async function saveWorktime() {
		await save(WORKTIME_KEYS);
		savedWorktime = Date.now();
	}

	/** Alle bekannten Zeitzonen, die aktuelle immer dabei. */
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

	/** Die Zeitzone laeuft NICHT ueber das Formular-Zwischenmodell. */
	async function saveTimeZone(tz: string) {
		if (!tz || tz === app.settings.timeZone) return;
		await app.updateSettings({ timeZone: tz });
		app.entriesVersion++; // abgeleitete Listen haengen an Tagesgrenzen
		savedWorktime = Date.now();
	}

	async function saveTimes() {
		await save(TIMES_KEYS);
		scheduleReminders();
		scheduleReportReminder();
		// Nur fragen, wenn ueberhaupt etwas benachrichtigen soll – beim Abschalten
		// nach der Erlaubnis zu fragen waere verkehrt herum.
		if (app.settings.reminderTimes.length > 0 || form.reportReminderEnabled) {
			await ensureNotificationPermission();
		}
		savedTimes = Date.now();
	}

	/** Umgeschalteter Update-Kanal, der noch nicht greift. */
	let channelChanged = $state(false);

	async function saveBetaUpdates() {
		await save(["betaUpdates"]);
		savedSystem = Date.now();
		channelChanged = true;
		logInfo(`Update-Kanal umgestellt auf ${form.betaUpdates ? "Beta" : "stabil"}`);
	}

	/** Neu starten, damit der Rust-Teil die Endpunkte neu setzt. */
	async function restartApp() {
		try {
			await flushLog();
			await relaunch();
		} catch (e) {
			toast.error(`Neustart nicht möglich: ${errorText(e)}`, { duration: 60000 });
		}
	}

	async function toggleAutostart(v: boolean) {
		// form.autostart ist via bind:checked bereits gesetzt; bei Fehler zuruecksetzen.
		try {
			if (v) await enable();
			else await disable();
			await app.updateSettings({ autostart: v });
			savedSystem = Date.now();
		} catch (e) {
			form.autostart = !v;
			toast.error(`Autostart fehlgeschlagen: ${e}`, { duration: 60000 });
		}
	}

	// ---- Benachrichtigungen im Browser ----
	// Der Browser fragt nur nach einer Nutzerhandlung - dafuer der Button.
	let meldeRecht = $state<NotificationPermission | "unbekannt">("unbekannt");

	$effect(() => {
		if (isTauri() || typeof Notification === "undefined") return;
		meldeRecht = Notification.permission;
	});

	async function meldungenErlauben() {
		const ok = await ensureNotificationPermission();
		meldeRecht = typeof Notification === "undefined" ? "denied" : Notification.permission;
		if (ok) toast.success("Benachrichtigungen sind jetzt erlaubt.");
		else toast.error("Der Browser hat die Erlaubnis nicht gegeben.");
	}

	// ---- Daten: ganze Jahre loeschen ----
	let years = $state<StoredYear[]>([]);
	let yearToDelete = $state<StoredYear | null>(null);
	let deleting = $state(false);

	// Neu laden, wenn sich Eintraege irgendwo geaendert haben - sonst taucht ein
	// neues Jahr erst nach einem Neuladen der Seite auf.
	$effect(() => {
		app.entriesVersion;
		void listEntryYears().then((y) => (years = y));
	});

	async function confirmDeleteYear() {
		const target = yearToDelete;
		if (!target) return;
		deleting = true;
		try {
			const months = await app.deleteYearEntries(target.year);
			toast.success(`${target.year} gelöscht (${months} Monatsdatei${months === 1 ? "" : "en"}).`);
			yearToDelete = null;
		} catch (e) {
			toast.error(`Löschen fehlgeschlagen: ${e}`);
		} finally {
			deleting = false;
		}
	}

	type Bereich = "erfassung" | "bericht" | "erinnerungen" | "konto" | "verwaltung" | "system" | "ueber";

	type BereichInfo = {
		id: Bereich;
		titel: string;
		icon: typeof TimerIcon;
		hinweis: string;
	};

	// Symbol und Untertitel gehoeren zum Bereich, nicht in die Navigation: die
	// Ueberschrift ueber den Karten zieht beides von hier.
	const BEREICHE = $derived.by(() => {
		const list: BereichInfo[] = [
			{
				id: "erfassung",
				titel: "Zeiterfassung",
				icon: TimerIcon,
				hinweis: "Wie der Timer sich verhält und woraus sich ein Arbeitstag rechnet."
			},
			{
				id: "bericht",
				titel: "Bericht",
				icon: FileTextIcon,
				hinweis: "Empfänger, Betreff und was außer den Zeiten noch angezeigt wird."
			},
			{
				id: "erinnerungen",
				titel: "Erinnerungen",
				icon: BellIcon,
				hinweis: "Wann die App sich von selbst meldet."
			},
			{
				id: "konto",
				titel: "Konto",
				icon: UserRoundIcon,
				hinweis: "Anmeldung, Geräte und der Abgleich zwischen ihnen."
			}
		];
		if (account.isAdmin) {
			list.push({
				id: "verwaltung",
				titel: "Verwaltung",
				icon: ShieldCheckIcon,
				hinweis: "Server-Backups, Einladungen und Registrierungsrichtlinien."
			});
		}
		if (capabilities.autostart || capabilities.updater || isTauri()) {
			list.push({
				id: "system",
				titel: "System",
				icon: MonitorCogIcon,
				hinweis: "Start mit Windows, Updates und die Daten auf diesem Gerät."
			});
		}
		list.push({
			id: "ueber",
			titel: "Über",
			icon: InfoIcon,
			hinweis: "Version, Datenschutz und Protokoll."
		});
		return list;
	});

	let bereich = $state<Bereich>("erfassung");

	const aktiverBereich = $derived(BEREICHE.find((b) => b.id === bereich) ?? BEREICHE[0]);

	// Suche und Dialog liegen in $lib/updater.svelte – der Hinweis-Toast beim Start
	// öffnet denselben Dialog, ohne dass jemand hier vorbeikommen muss.
	function checkUpdate() {
		void checkForUpdate();
	}
</script>

<!-- Zweispaltig ab lg: links die Bereiche, rechts die Karten. Die alte Reihe aus
     Buttons ueber einem zweispaltigen Kartenraster liess weder erkennen, wo man
     gerade ist, noch in welcher Reihenfolge die Karten zu lesen sind. -->
<div class="flex flex-col gap-5 lg:flex-row lg:items-start lg:gap-8">
	<!-- Bereiche schalten per {#if}, nicht ueber eine Tabs-Komponente: die wuerde
	     alle Inhalte gleichzeitig mounten, und unsichtbare Karten liefen mit
	     veraltetem Zustand weiter.
	     Schmal: waagerechte Leiste ueber den Karten, notfalls scrollbar. Ab lg:
	     eigene Spalte, die beim Scrollen stehen bleibt. -->
	<nav
		aria-label="Einstellungsbereiche"
		class="scrollbar-lose bg-muted/50 flex shrink-0 gap-1 overflow-x-auto rounded-xl p-1 lg:sticky lg:top-24 lg:w-56 lg:flex-col lg:overflow-visible lg:bg-transparent lg:p-0"
	>
		{#each BEREICHE as b (b.id)}
			{@const Icon = b.icon}
			<button
				type="button"
				onclick={() => (bereich = b.id)}
				aria-current={bereich === b.id ? "page" : undefined}
				class={cn(
					"text-muted-foreground hover:text-foreground focus-visible:ring-ring/50 inline-flex h-9 shrink-0 items-center gap-2.5 rounded-lg px-3 text-sm font-medium whitespace-nowrap transition-colors outline-none focus-visible:ring-3 lg:w-full lg:justify-start",
					bereich === b.id
						? "bg-background text-foreground ring-foreground/10 ring-1 lg:bg-muted lg:ring-0"
						: "hover:bg-background/60 lg:hover:bg-muted/60"
				)}
			>
				<Icon class="size-4 shrink-0" />
				{b.titel}
			</button>
		{/each}
	</nav>

	<!-- max-w-3xl: eine Einstellungszeile ueber die volle Fensterbreite reisst
	     Beschriftung und Schalter so weit auseinander, dass beides nicht mehr als
	     Paar zu lesen ist. -->
	<div class="min-w-0 flex-1 space-y-4 lg:max-w-3xl">
		<div class="space-y-0.5">
			<h2 class="text-lg leading-tight font-semibold tracking-tight">{aktiverBereich.titel}</h2>
			<p class="text-muted-foreground text-sm">{aktiverBereich.hinweis}</p>
		</div>

		{#if bereich === "erfassung"}
			<SettingsCard
				title="Timer & Hotkey"
				description="Verhalten von Timer, Hinweisen und Tastenkürzel."
				savedAt={savedTracking}
			>
				<!-- Braucht die Leerlauf-Erkennung des Systems - im Browser gibt es die nicht. -->
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

				<!-- Ohne globalen Hotkey gibt es auch nichts zu melden. -->
				{#if capabilities.globalShortcuts}
					<SettingToggle
						id="scnotify"
						title="Hinweis bei Shortcut-Start/Stop"
						description="Kurze Meldung, verschwindet selbst."
						bind:checked={form.shortcutNotify}
						onCheckedChange={() => saveTracking()}
					/>
				{/if}

				<!-- Schalter und Feinheiten in einer Zeile: die Minutenfelder gehoeren
				     sichtbar zum Schalter darueber, nicht in eine eigene Zeile. -->
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

				<!-- Ein Tastenkuerzel, das auch dann greift, wenn das Fenster nicht vorn ist,
				     kann nur das Betriebssystem vergeben. Der Browser darf das nicht. -->
				{#if capabilities.globalShortcuts}
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
									<Button variant="outline" size="sm" onclick={() => (recordingToggle = true)}>
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
				savedAt={savedWorktime}
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
							onchange={(e) => saveTimeZone(e.currentTarget.value)}
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
		{:else if bereich === "bericht"}
			<SettingsCard
				title="Bericht & E-Mail"
				description="Wohin der Monatsbericht geht und wie er betitelt ist."
				savedAt={savedReport}
			>
				<!-- Die drei Felder gehoeren zusammen und bekommen deshalb keine
				     Trennlinien untereinander. -->
				<div class="grid gap-3 sm:grid-cols-2">
					<div class="space-y-1.5 sm:col-span-2">
						<Label for="boss">E-Mail der/des Vorgesetzten</Label>
						<Input
							id="boss"
							type="email"
							bind:value={form.bossEmail}
							placeholder="name@firma.de"
							onchange={saveReport}
						/>
					</div>
					<div class="space-y-1.5">
						<Label for="sender">Dein Name (optional)</Label>
						<Input id="sender" bind:value={form.senderName} onchange={saveReport} />
					</div>
					<div class="space-y-1.5">
						<Label for="subj">Betreff-Vorlage</Label>
						<Input id="subj" bind:value={form.reportSubjectTemplate} onchange={saveReport} />
						<p class="text-muted-foreground text-xs">
							{"{month}"} = Monat, {"{name}"} = dein Name
						</p>
					</div>
				</div>
				<SettingToggle
					id="stats"
					title="Auswertung anzeigen"
					description="Saldo, Stunden je Aktivität und Jahres-Heatmap im Tab „Bericht“. Nur für dich – die E-Mail bleibt unverändert."
					bind:checked={form.statsEnabled}
					onCheckedChange={() => saveReport()}
				/>
				<SettingToggle
					id="arbzg"
					title="Arbeitszeit-Check anzeigen"
					description="Schätzt nach dem Arbeitszeitgesetz, ob der 24-Wochen-Schnitt von 8 h zu reißen droht, und was sich am Tempo ändern müsste. Nur für dich – die E-Mail bleibt unverändert."
					bind:checked={form.arbzgEnabled}
					onCheckedChange={() => saveReport()}
				/>
				<SettingToggle
					id="arbzghint"
					title="Hinweis beim Tracking"
					description="Zeigt oben auf der Tracking-Seite eine Zeile, wenn der 24-Wochen-Schnitt zu reißen droht. Schweigt, solange alles im grünen Bereich ist."
					bind:checked={form.arbzgTrackingHint}
					onCheckedChange={() => saveReport()}
				/>
			</SettingsCard>

			<!-- Liest den Outlook-Posteingang per COM - gibt es nur auf dem Desktop. -->
			{#if capabilities.outlook}
				<SettingsCard
					title="Chef-Modus"
					description="Prüft im Outlook-Posteingang, wer seinen Monatsbericht geschickt hat und wer nicht."
					savedAt={savedBoss}
				>
					<SettingToggle
						id="bossmode"
						title="Chef-Modus"
						description="Blendet den Tab „Team“ ein. Es wird ausschließlich gelesen – keine Mail wird verschoben oder markiert."
						bind:checked={form.bossMode}
						onCheckedChange={() => saveBossMode()}
					/>

					{#if form.bossMode}
						<div class="space-y-2">
							<Label>Team</Label>
							<p class="text-muted-foreground text-xs leading-relaxed">
								Von wem monatlich ein Bericht erwartet wird. Die Zuordnung läuft über die E-Mail-Adresse
								– fehlt jemand hier, taucht sein Bericht trotzdem auf, nur eben ohne „fehlt“-Abgleich.
							</p>
							<!-- Nach id, nicht nach Index: beim Loeschen einer Zeile ruecken sonst
							     alle folgenden Felder eine Position hoch und zeigen fremde Werte. -->
							{#each form.team as m, i (m.id)}
								<div class="flex gap-2">
									<Input placeholder="Name" bind:value={form.team[i].name} onchange={saveBossMode} />
									<Input
										type="email"
										placeholder="name@firma.de"
										bind:value={form.team[i].email}
										onchange={saveBossMode}
									/>
									<Button
										variant="ghost"
										size="icon"
										title="Aus dem Team entfernen"
										onclick={() => {
											form.team = form.team.filter((_, j) => j !== i);
											void saveBossMode();
										}}
									>
										<Trash2Icon class="size-4" />
									</Button>
								</div>
							{/each}
							<Button
								variant="outline"
								size="sm"
								onclick={() =>
									(form.team = [...form.team, { id: crypto.randomUUID(), name: "", email: "" }])}
							>
								<PlusIcon class="size-4" /> Mitarbeiter
							</Button>
						</div>

						<div class="space-y-1.5">
							<Label for="tsubj">Betreff enthält</Label>
							<Input id="tsubj" bind:value={form.teamSubjectFilter} onchange={saveBossMode} />
							<p class="text-muted-foreground text-xs leading-relaxed">
								Nur Mails mit diesem Text im Betreff werden gelesen. Standard ist der Anfang der
								Betreff-Vorlage, die TimeTracker selbst verschickt.
							</p>
						</div>

						<SettingToggle
							id="tsubf"
							title="Unterordner mitlesen"
							description="Auch Unterordner des Posteingangs durchsuchen – für alle, die Berichte per Regel einsortieren lassen."
							bind:checked={form.teamScanSubfolders}
							onCheckedChange={() => saveBossMode()}
						/>
					{/if}
				</SettingsCard>
			{/if}
		{:else if bereich === "erinnerungen"}
			<SettingsCard
				title="Tägliche Erinnerungen"
				description="Zu diesen Uhrzeiten erinnert dich die App, deine Zeiten einzutragen."
				savedAt={savedTimes}
			>
				<div class="space-y-3">
					{#if !isTauri()}
						<!-- Im Browser haengt jede Benachrichtigung an dieser Erlaubnis, auch
						     die Auto-Stopp-Warnung. Ohne sie kommt still nichts an. -->
						{#if meldeRecht === "granted"}
							<p class="text-muted-foreground flex items-center gap-1.5 text-xs">
								<span class="size-1.5 rounded-full bg-emerald-500"></span>
								Benachrichtigungen sind für diesen Browser erlaubt.
							</p>
						{:else if meldeRecht === "denied"}
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
								<Button size="sm" onclick={meldungenErlauben}>Benachrichtigungen erlauben</Button>
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
							// Ohne Speichern-Button muss das Anlegen selbst persistieren – sonst
							// stuende die neue Zeit nur im Fenster und waere beim Neustart weg.
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
		{:else if bereich === "konto"}
			<AccountPanel />
			<PasskeyPanel />
			<DangerZonePanel />
		{:else if bereich === "verwaltung"}
			<AdminPanel />
		{:else if bereich === "system"}
			<!-- Im Browser bleibt von dieser Karte nichts brauchbares - nur Autostart
			     und Updater gehoeren rein. -->
			{#if capabilities.autostart || capabilities.updater}
				<SettingsCard
					title="Start & Updates"
					description="Wie die App startet und woher sie neue Versionen holt."
					savedAt={savedSystem}
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
						{#if channelChanged}
							<!-- Update-Kanal wird nur beim Start gelesen, wirkt also erst nach Neustart. -->
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
							<Button variant="outline" size="sm" onclick={checkUpdate} disabled={updater.checking}>
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
					{#if years.length === 0}
						<p class="text-muted-foreground text-sm">Noch keine erfassten Zeiten.</p>
					{:else}
						{#each years as y (y.year)}
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
		{:else if bereich === "ueber"}
			<SettingsCard
				title="Datenschutz"
				description="Was diese App über sich selbst meldet – und was nie."
			>
				<SettingToggle
					id="errreports"
					title="Anonyme Fehlermeldungen senden"
					description="Hilft, Abstürze und Fehler zu finden, die nur auf anderen Rechnern auftreten."
					bind:checked={form.errorReportsEnabled}
					onCheckedChange={() => saveErrorReports()}
				/>

				<div class="text-muted-foreground space-y-2 text-xs leading-relaxed">
					<p>
						<span class="text-foreground font-medium">Mit diesem Schalter:</span> der Text von
						Fehlermeldungen und Abstürzen, bereinigt um Dateipfade, Adressen und lange Zahlen. Nie das
						Detail dazu – dort stünden Aufruflisten und Dateinamen.
					</p>
					<p>
						<span class="text-foreground font-medium">Nie:</span> Aktivitäten, Projekte, Notizen, Zeiten,
						Namen, E-Mail-Adressen, Dateien – nichts aus deinen Einträgen. Es gibt keine Kennung, die
						dich über Programmstarts hinweg wiedererkennt, und keine gespeicherte IP-Adresse. Start- und
						Endzeiten des Programms werden bewusst nicht gemeldet, weil sich daraus deine Arbeitszeiten
						ablesen ließen.
					</p>
					<p>Verarbeitet wird über Aptabase (EU-Server). Es fallen keine personenbezogenen Daten an.</p>
				</div>
			</SettingsCard>

			<LogPanel />

			<SettingsCard
				title="TimeTracker"
				description="Zeiterfassung für Projektzeiten mit Monatsbericht."
			>
				<div class="flex items-center justify-between gap-3">
					<div class="flex items-center gap-3">
						<button type="button" class="cursor-none" onclick={tapLogo} aria-label="TimeTracker">
							<img src="/logo.svg" alt="TimeTracker" class="h-10 w-auto" />
						</button>
						<div>
							<div class="flex items-center gap-1.5">
								<span class="text-sm font-medium">TimeTracker</span>
								{#if app.devMode}
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
					<Button variant="outline" size="sm" onclick={() => openExternal(REPO_URL)}>
						<ExternalLinkIcon class="size-4" /> GitHub
					</Button>
				</div>

				{#if app.devMode}
					<div>
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
						<div class="text-muted-foreground mt-3 mb-1.5 text-xs">Ladebildschirm</div>
						<div class="flex flex-wrap gap-2">
							<Button
								variant="secondary"
								size="sm"
								title="Startet die App neu und lässt den Schritt „Einträge laden“ scheitern. „Erneut versuchen“ bringt alles zurück."
								onclick={() => app.devSimulateStartFault("error")}
							>
								Startfehler
							</Button>
							<Button
								variant="secondary"
								size="sm"
								title="Startet die App neu und hält den Schritt „Einträge laden“ 20 s auf – danach läuft er von selbst weiter."
								onclick={() => app.devSimulateStartFault("hang")}
							>
								Start hängen lassen
							</Button>
						</div>
						<p class="text-muted-foreground mt-1.5 text-xs leading-relaxed">
							Beide durchlaufen den echten Startweg. An den erfassten Zeiten ändert sich nichts, ein
							laufender Timer zählt weiter.
						</p>
					</div>
				{/if}
			</SettingsCard>
		{/if}
	</div>
</div>

<!-- Endgueltig, kein Papierkorb - deshalb vorher genau sagen, was verschwindet. -->
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
